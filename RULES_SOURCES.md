# Rules sources and implementation status

GuanDan Lab is a teaching implementation, not an official rule publication. The baseline is the 2022 **《竞技掼蛋竞赛规则（试行）》**, reviewed by the General Administration of Sport's Board and Card Games Administrative Center (中国棋院).

Primary public references:

- [国家体育总局棋牌运动管理中心：掼牌（掼蛋）赛事活动办赛指南](https://www.sport.gov.cn/qpzx/n27319064/n27319058/c27429584/content.html), which cites the trial competition rules as a governing document.
- [国家体育总局棋牌运动管理中心：2022 年征求《竞技掼蛋扑克竞赛规则》意见的公告索引](https://www.sport.gov.cn/qpzx/n5384/index_3654_26.html).
- [国家体育总局：赛事采用棋牌中心审定的试行规则与补充规定](https://www.sport.gov.cn/n14471/n14495/n14543/c27199805/content.html).

## Implemented teaching scope

- Two 54-card decks, four seats and fixed opposite-seat partnerships.
- Singles, pairs, triples, triple-with-pair, straight, three consecutive pairs, two consecutive triples, rank bombs, straight flushes and four-joker bomb.
- Level cards and the heart level-card wildcard within supported multi-card patterns.
- Following, passing, trick reset, partner take-over, finish order, double-up and level advancement. A new trick belongs to the last beating player only after every other active seat has had a response. If the player emptied their hand, the still-active partner borrows the lead **only after all remaining seats declined to beat that final play**. The public explanation by competition referee [王春国](https://news.bjd.com.cn/2024/02/20/10704950.shtml) confirms both conditions.
- If a played set with red-heart level wildcards has multiple distinct interpretations (notably three-with-pair), the local player declares the type/main rank before playing; this interpretation is stored in the action log. Existing unambiguous and earlier auto-resolved records remain replayable.
- Common single/double tribute, return tribute and two-big-joker resistance flow. Return-card eligibility follows the printed rank at most 10, including a rank-9 card when playing level 9; it must not use its trump-adjusted fighting power.

## Known teaching simplifications

- Tournament organization, clocks, penalties, duplicate formats, appeals and scoring tables are outside the game engine.
- Tribute and return tribute are automated for training rather than selected interactively.
- Regional table customs may differ on display, reporting and edge cases. They must be implemented as named variants, not silently mixed into the baseline.
- The local training engine still chooses tribute/return cards automatically, does not enforce tournament timing or mandatory public 10-card announcement, and auto-resolves wildcard declarations made by AI agents rather than training declaration choice. Full competition-rule compliance has **not** been independently certified.
- Before changing a ruling, add a minimal card fixture and cite the exact baseline section or regional source in the Rule Issue template.
