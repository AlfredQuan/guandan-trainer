"""CPU cloud trainer; imports do not start training. Uses the existing JS engine."""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import random
import shutil
import subprocess
import time
import zipfile

import numpy as np
import torch
from torch import nn


class ActionNetwork(nn.Module):
    def __init__(self, width: int, hidden: int = 64):
        super().__init__()
        self.hidden = nn.Linear(width, hidden)
        self.head = nn.Linear(hidden, 1)

    def forward(self, x):
        return self.head(torch.tanh(self.hidden(x))).squeeze(-1)


def load_rows(path: Path):
    meta = json.loads(Path(str(path) + '.meta.json').read_text())
    rows = []
    outcomes = {}
    with path.open() as stream:
        for line in stream:
            raw = json.loads(line)
            x = np.asarray(raw['features'], dtype=np.float32)
            if raw['schema'] != 1 or x.ndim != 2 or x.shape[1] != len(meta['features']) or not np.isfinite(x).all():
                raise ValueError('Invalid features')
            if not (0 <= raw['teacher'] < len(x) and 0 <= raw['chosen'] < len(x)):
                raise ValueError('Invalid action index')
            if not math.isfinite(raw['reward']) or abs(raw['reward']) > 1 or not math.isfinite(raw['logProbability']):
                raise ValueError('Invalid label')
            seat = raw.get('seat')
            if seat is not None:
                if type(seat) is not int or seat not in (0, 1, 2, 3):
                    raise ValueError('Invalid seat')
                key = (raw['dealId'], seat % 2)
                previous = outcomes.setdefault(key, raw['reward'])
                if previous != raw['reward']:
                    raise ValueError('Inconsistent per-team outcome in deal')
                opposing = outcomes.get((raw['dealId'], 1 - seat % 2))
                if opposing is not None and opposing != -raw['reward']:
                    raise ValueError('Opposing teams must have opposite terminal rewards')
            raw['features'] = x
            rows.append(raw)
    if not rows:
        raise ValueError('Empty dataset')
    return rows, meta


def batch(rows, indices):
    chosen = [rows[i] for i in indices]
    width = chosen[0]['features'].shape[1]
    x = np.zeros((len(chosen), max(len(r['features']) for r in chosen), width), dtype=np.float32)
    valid = np.zeros(x.shape[:2], dtype=bool)
    for i, row in enumerate(chosen):
        x[i, :len(row['features'])] = row['features']
        valid[i, :len(row['features'])] = True
    return torch.from_numpy(x), torch.from_numpy(valid), chosen


def logits_for(model, rows, indices, temperature=1.0):
    x, mask, picked = batch(rows, indices)
    logits = (model(x) / temperature).masked_fill(~mask, -1e9)
    return logits, picked


def imitation_metrics(model, rows, batch_size):
    correct, total, loss = 0, 0, 0.0
    model.eval()
    with torch.no_grad():
        for start in range(0, len(rows), batch_size):
            logits, picked = logits_for(model, rows, range(start, min(start + batch_size, len(rows))))
            target = torch.tensor([r['teacher'] for r in picked])
            loss += nn.functional.cross_entropy(logits, target, reduction='sum').item()
            correct += (logits.argmax(-1) == target).sum().item()
            total += len(picked)
    return {'loss': loss / total, 'accuracy': correct / total, 'rows': total}


def export_model(model, features, path):
    data = {'version': 1, 'kind': 'guandan-action-mlp', 'features': features,
            'w1': model.hidden.weight.detach().tolist(), 'b1': model.hidden.bias.detach().tolist(),
            'w2': model.head.weight.detach()[0].tolist(), 'b2': model.head.bias.item()}
    Path(path).write_text(json.dumps(data, allow_nan=False))


def run_engine(bundle, mode, output, games, offset, model=None, temperature=0.8, record_seats=1):
    command = [node_executable(bundle), str(bundle / 'offline/cloud-selfplay.js'), mode, '--games', str(games),
               '--offset', str(offset), '--output', str(output)]
    if model is not None:
        command += ['--model', str(model), '--temperature', str(temperature)]
    if mode == 'generate':
        command += ['--record-seats', str(record_seats)]
    subprocess.run(command, check=True)


def input_mounts():
    inputs = Path('/kaggle/input')
    if not inputs.is_dir():
        return []
    discovered = []
    for current, dirs, _files in os.walk(inputs):
        relative = Path(current).relative_to(inputs)
        if len(relative.parts) >= 5:
            dirs[:] = []
        discovered.append(Path(current))
    return discovered


def node_executable(bundle: Path):
    destination = Path('/kaggle/working/guandan-node')
    binary = destination / 'node'
    for dataset in [bundle.parent, *input_mounts()]:
        supplied = dataset / 'node-linux-x64/node'
        if supplied.is_file():
            if not binary.is_file():
                destination.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(supplied, binary)
                binary.chmod(0o755)
            return str(binary)
        archive_path = dataset / 'node-linux-x64.zip'
        if archive_path.is_file():
            if not binary.is_file():
                destination.mkdir(parents=True, exist_ok=True)
                with zipfile.ZipFile(archive_path) as archive:
                    if archive.namelist() != ['node']:
                        raise ValueError('Unexpected Node runtime archive')
                    archive.extract('node', destination)
                binary.chmod(0o755)
            return str(binary)
    available = shutil.which('node')
    if available:
        return available
    raise RuntimeError(f'Node.js unavailable next to {bundle}; attached datasets: {[p.name for p in input_mounts()]}')


def resolve_bundle(bundle: Path, output: Path) -> Path:
    required = ('offline/cloud-selfplay.js', 'offline/neural-policy.js', 'offline/check-model.mjs', 'LICENSE')
    candidates = [bundle]
    if bundle.is_dir():
        candidates.append(bundle / 'engine')
    for mount in input_mounts():
        candidates.extend((mount / 'engine', mount))
    valid = [p for p in candidates if p.is_dir() and all((p / name).is_file() for name in required)]
    if not valid:
        archives = [bundle, bundle / 'engine.zip']
        archives.extend(mount / 'engine.zip' for mount in input_mounts())
        for archive_path in archives:
            if archive_path.is_file() and archive_path.suffix == '.zip':
                root = output / 'engine'
                root.mkdir(exist_ok=False)
                with zipfile.ZipFile(archive_path) as archive:
                    for entry in archive.infolist():
                        if not (root / entry.filename).resolve().is_relative_to(root.resolve()):
                            raise ValueError('Unsafe path inside engine archive')
                    archive.extractall(root)
                valid.append(root)
                break
    if not valid:
        raise ValueError(f'Engine bundle missing. Mount directories: {[str(p) for p in input_mounts()]}')
    for relative in required:
        if not (valid[0] / relative).is_file():
            raise ValueError(f'Engine bundle is missing {relative}')
    print(f'Using engine bundle: {valid[0]}', flush=True)
    return valid[0]


def verify_rollout_probabilities(model, rows, temperature, batch_size):
    model.eval()
    with torch.no_grad():
        for start in range(0, len(rows), batch_size):
            logits, picked = logits_for(model, rows, range(start, min(start + batch_size, len(rows))), temperature)
            actual = torch.log_softmax(logits, dim=-1).gather(
                1, torch.tensor([r['chosen'] for r in picked]).unsqueeze(-1)).squeeze(-1)
            # A deterministic rollout can serialize every logProbability as integer 0.
            # Match the network's floating dtype explicitly before allclose.
            expected = torch.tensor([r['logProbability'] for r in picked], dtype=actual.dtype, device=actual.device)
            if not torch.allclose(actual, expected, atol=5e-4, rtol=1e-4):
                raise ValueError('Self-play behavior log probabilities do not match frozen model')


def save_checkpoint(model, optimizer, config, name, generation, directory):
    torch.save({'model': model.state_dict(), 'optimizer': optimizer.state_dict(),
                'config': vars(config), 'generation': generation,
                'torch_rng': torch.get_rng_state(), 'python_rng': random.getstate(),
                'numpy_rng': np.random.get_state()}, directory / f'{name}.pt')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--bundle', type=Path, default=Path('/kaggle/input/datasets/alfredq/guandan-ai-engine-v017/engine'))
    parser.add_argument('--output', type=Path, default=Path('/kaggle/working/guandan-training'))
    parser.add_argument('--train-deals', type=int, default=240)
    parser.add_argument('--validation-deals', type=int, default=60)
    parser.add_argument('--epochs', type=int, default=12)
    parser.add_argument('--generations', type=int, default=3)
    parser.add_argument('--selfplay-deals', type=int, default=80)
    parser.add_argument('--validation-pairs', type=int, default=60)
    parser.add_argument('--test-pairs', type=int, default=220)
    parser.add_argument('--batch-size', type=int, default=32)
    parser.add_argument('--threads', type=int, default=2)
    parser.add_argument('--seed', type=int, default=20261004)
    parser.add_argument('--record-seats', type=int, choices=(1, 4), default=4)
    cfg = parser.parse_args()
    for key in ['train_deals', 'validation_deals', 'epochs', 'selfplay_deals', 'validation_pairs', 'test_pairs', 'batch_size', 'threads']:
        if getattr(cfg, key) < 1:
            raise ValueError(key)
    if cfg.generations < 0 or max(cfg.train_deals, cfg.validation_deals, cfg.validation_pairs, cfg.test_pairs, cfg.selfplay_deals) > 100000 or cfg.generations > 20:
        raise ValueError('Invalid deal budget')
    cfg.output.mkdir(parents=True, exist_ok=True)
    cfg.bundle = cfg.bundle.resolve()
    cfg.output = cfg.output.resolve()
    cfg.bundle = resolve_bundle(cfg.bundle, cfg.output)
    node_executable(cfg.bundle)
    torch.set_num_threads(cfg.threads)
    torch.manual_seed(cfg.seed)
    np.random.seed(cfg.seed)
    random.seed(cfg.seed)
    torch.use_deterministic_algorithms(True)
    start = time.time()
    # Disjoint ranges are fixed before training. The test range is used exactly once.
    train_path, val_path = cfg.output / 'train.jsonl', cfg.output / 'validation.jsonl'
    run_engine(cfg.bundle, 'generate', train_path, cfg.train_deals, 0, record_seats=cfg.record_seats)
    run_engine(cfg.bundle, 'generate', val_path, cfg.validation_deals, 1_000_000, record_seats=cfg.record_seats)
    train, train_meta = load_rows(train_path)
    validation, val_meta = load_rows(val_path)
    assert train_meta['features'] == val_meta['features']
    assert {r['dealId'] for r in train}.isdisjoint(r['dealId'] for r in validation)
    features = train_meta['features']
    model = ActionNetwork(len(features)).cpu()
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.001, weight_decay=1e-4)
    history, best_loss, best_state = [], math.inf, None
    for epoch in range(cfg.epochs):
        model.train()
        order = list(range(len(train)))
        random.shuffle(order)
        for start_at in range(0, len(order), cfg.batch_size):
            logits, picked = logits_for(model, train, order[start_at:start_at + cfg.batch_size])
            loss = nn.functional.cross_entropy(logits, torch.tensor([r['teacher'] for r in picked]))
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
        metrics = imitation_metrics(model, validation, cfg.batch_size)
        history.append({'stage': 'imitation', 'epoch': epoch + 1, **metrics})
        print(json.dumps(history[-1]), flush=True)
        if metrics['loss'] < best_loss:
            best_loss = metrics['loss']
            best_state = copy.deepcopy(model.state_dict())
    model.load_state_dict(best_state)
    export_model(model, features, cfg.output / 'cold-start.json')
    save_checkpoint(model, optimizer, cfg, 'cold-start', 0, cfg.output)
    # Exact exported-inference parity is checked by the TypeScript runtime in Kaggle.
    x = np.random.default_rng(cfg.seed).normal(size=(4, len(features))).astype(np.float32)
    with torch.no_grad():
        expected = model(torch.from_numpy(x)).tolist()
    fixture = cfg.output / 'parity.json'
    fixture.write_text(json.dumps({'features': x.tolist(), 'scores': expected}))
    subprocess.run([node_executable(cfg.bundle), str(cfg.bundle / 'offline/check-model.mjs'), str(cfg.output / 'cold-start.json'), str(fixture)], check=True)
    best_model = cfg.output / 'cold-start.json'
    duel_path = cfg.output / 'validation-duel-0.json'
    run_engine(cfg.bundle, 'evaluate', duel_path, cfg.validation_pairs, 1_100_000, best_model, 0)
    best_rate = json.loads(duel_path.read_text())['rate']
    history.append({'stage': 'validation-duel', 'generation': 0, 'rate': best_rate})
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.0002, weight_decay=1e-4)
    for generation in range(cfg.generations):
        # All four seats act with this frozen snapshot. New deals every generation.
        snapshot = cfg.output / f'snapshot-{generation}.json'
        export_model(model, features, snapshot)
        rollout_path = cfg.output / f'rollout-{generation}.jsonl'
        temperature = 0.8
        run_engine(cfg.bundle, 'generate', rollout_path, cfg.selfplay_deals, 3_000_000 + generation * 100_000, snapshot, temperature, cfg.record_seats)
        rollout, rollout_meta = load_rows(rollout_path)
        assert rollout_meta['features'] == features
        if {r['dealId'] for r in rollout} & {r['dealId'] for r in train + validation}:
            raise ValueError('Training/validation deal IDs overlap with rollout')
        verify_rollout_probabilities(model, rollout, temperature, cfg.batch_size)
        # Constant zero baseline; terminal reward is signed team upgrade / 3.
        # No hidden-state critic. Clipped policy gradient plus a frozen teacher anchor.
        model.train()
        order = list(range(len(rollout)))
        random.shuffle(order)
        losses = []
        for start_at in range(0, len(order), cfg.batch_size):
            logits, picked = logits_for(model, rollout, order[start_at:start_at + cfg.batch_size], temperature)
            distribution = torch.distributions.Categorical(logits=logits)
            logp = distribution.log_prob(torch.tensor([r['chosen'] for r in picked]))
            old_logp = torch.tensor([r['logProbability'] for r in picked], dtype=logp.dtype, device=logp.device)
            advantage = torch.tensor([r['reward'] for r in picked], dtype=logp.dtype, device=logp.device)
            ratio = (logp - old_logp).clamp(-20, 20).exp()
            policy_loss = -torch.minimum(ratio * advantage, ratio.clamp(0.8, 1.2) * advantage).mean()
            anchors = random.sample(range(len(train)), min(cfg.batch_size, len(train)))
            anchor_logits, anchor_rows = logits_for(model, train, anchors)
            anchor_loss = nn.functional.cross_entropy(anchor_logits, torch.tensor([r['teacher'] for r in anchor_rows]))
            loss = policy_loss - 0.005 * distribution.entropy().mean() + 0.1 * anchor_loss
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            losses.append(loss.item())
        checkpoint = cfg.output / f'generation-{generation + 1}.json'
        export_model(model, features, checkpoint)
        save_checkpoint(model, optimizer, cfg, f'generation-{generation + 1}', generation + 1, cfg.output)
        duel_path = cfg.output / f'validation-duel-{generation + 1}.json'
        run_engine(cfg.bundle, 'evaluate', duel_path, cfg.validation_pairs, 1_100_000, checkpoint, 0)
        rate = json.loads(duel_path.read_text())['rate']
        history.append({'stage': 'selfplay', 'generation': generation + 1, 'loss': float(np.mean(losses)), 'validationRate': rate})
        print(json.dumps(history[-1]), flush=True)
        if rate > best_rate:
            best_model, best_rate = checkpoint, rate
    # Select on validation only, then seal one final held-out evaluation.
    selected = cfg.output / 'model.json'
    selected.write_bytes(best_model.read_bytes())
    final_path = cfg.output / 'heldout-duel.json'
    run_engine(cfg.bundle, 'evaluate', final_path, cfg.test_pairs, 4_000_000, selected, 0)
    final = json.loads(final_path.read_text())
    # The engine may be extracted into the output directory while the reference stays on the input mount.
    reference_path = next((path for path in [cfg.bundle.parent / 'reference-v016.json',
                                          *(mount / 'reference-v016.json' for mount in input_mounts())]
                           if path.is_file()), None)
    reference = None
    if reference_path is not None:
        reference_output = cfg.output / 'reference-duel.json'
        run_engine(cfg.bundle, 'evaluate', reference_output, cfg.test_pairs, 4_000_000, reference_path, 0)
        reference = json.loads(reference_output.read_text())
        if [x['seed'] for x in final['perSeed']] != [x['seed'] for x in reference['perSeed']]:
            raise ValueError('Independent paired comparison has mismatched deals')
    paired_gain = None
    if reference:
        differences = [(sum(int(game['won']) for game in new['games']) -
                        sum(int(game['won']) for game in old['games'])) / 2
                       for new, old in zip(final['perSeed'], reference['perSeed'])]
        mean_gain = sum(differences) / len(differences)
        radius = math.sqrt(2 * math.log(2 / 0.05) / len(differences))
        paired_gain = {'newWins': final['wins'], 'referenceWins': reference['wins'],
                       'difference': mean_gain, 'lower95': max(-1, mean_gain - radius),
                       'upper95': min(1, mean_gain + radius), 'pairs': len(differences),
                       'rule': 'Same fresh dealt seeds, both team swaps; two-sided 95% Hoeffding bound for bounded paired gain.'}
    report = {'status': 'completed', 'device': 'cpu', 'torchVersion': torch.__version__,
              'config': {k: str(v) if isinstance(v, Path) else v for k, v in vars(cfg).items()},
              'history': history, 'selected': best_model.name,
              'modelSha256': hashlib.sha256(selected.read_bytes()).hexdigest(),
              'elapsedSeconds': time.time() - start, 'heldout': final,
              'referenceHeldout': {key: value for key, value in reference.items() if key != 'perSeed'} if reference else None,
              'comparison': paired_gain,
              'scope': 'Relative team first-finish rate against frozen structured AI; not calibrated in-game win probability.'}
    (cfg.output / 'training-report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps({k: v for k, v in report.items() if k not in ['history', 'heldout']}, default=str), flush=True)
    print(json.dumps({k: v for k, v in final.items() if k != 'perSeed'}), flush=True)


if __name__ == '__main__':
    main()
