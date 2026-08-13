const STATES = ["DONE", "READY", "BLOCKED", "REFINE", "DEVIATED"];
const ATTENTION = [null, "UPCOMING", "PENDING", "RECORDED", "COMPLETE"];

function ticket(ticketId, index) {
  return {
    ticketId,
    outcome: `Deterministic dense fixture outcome ${ticketId}.`,
    fixtureState: STATES[index % STATES.length],
    fixtureAttention: ATTENTION[index % ATTENTION.length],
  };
}

function relation(prerequisiteTicketId, dependentTicketId) {
  return {
    prerequisiteTicketId,
    dependentTicketId,
    relationRef: `${prerequisiteTicketId}->${dependentTicketId}`,
  };
}

function wideHubFixture() {
  const roots = Array.from({ length: 10 }, (_, index) => `root-${index}`);
  const stage = Array.from({ length: 10 }, (_, index) => `stage-${index}`);
  const bridges = Array.from({ length: 8 }, (_, index) => `bridge-${index}`);
  const finishes = Array.from({ length: 10 }, (_, index) => `finish-${index}`);
  const tails = Array.from({ length: 3 }, (_, index) => `tail-${index}`);
  const ids = [...roots, ...stage, "causal-hub", ...bridges, ...finishes, ...tails];
  const relations = [];
  for (let index = 0; index < 10; index += 1) {
    relations.push(relation(roots[index], stage[(index * 7) % 10]));
    relations.push(relation(roots[index], stage[(index * 7 + 3) % 10]));
  }
  for (let index = 0; index < 5; index += 1) {
    relations.push(relation(stage[index], "causal-hub"));
    relations.push(relation("causal-hub", finishes[index]));
  }
  for (let index = 0; index < bridges.length; index += 1) {
    relations.push(relation(stage[(index * 3) % 10], bridges[index]));
    relations.push(relation(bridges[index], finishes[(index * 7 + 2) % 10]));
  }
  for (let index = 0; index < 4; index += 1) {
    relations.push(relation(roots[index], finishes[index + 6]));
  }
  relations.push(
    relation(finishes[1], tails[2]),
    relation(finishes[5], tails[0]),
    relation(finishes[8], tails[1]),
  );
  return {
    name: "wide-hub-and-long-edges",
    tickets: ids.map(ticket),
    relations,
  };
}

function braidedRanksFixture() {
  const ranks = Array.from({ length: 6 }, (_, rank) =>
    Array.from({ length: 6 }, (_, index) => `rank-${rank}-${index}`));
  const ids = ranks.flat();
  const relations = [];
  for (let rank = 0; rank < ranks.length - 1; rank += 1) {
    for (let index = 0; index < 6; index += 1) {
      relations.push(relation(ranks[rank][index], ranks[rank + 1][(index * 5 + rank) % 6]));
      relations.push(relation(ranks[rank][index], ranks[rank + 1][(index * 5 + rank + 2) % 6]));
    }
  }
  relations.push(
    relation(ranks[0][0], ranks[4][5]),
    relation(ranks[0][5], ranks[5][0]),
    relation(ranks[1][2], ranks[5][4]),
  );
  return {
    name: "braided-ranks-and-long-edges",
    tickets: ids.map(ticket),
    relations,
  };
}

export const denseGraphFixtures = Object.freeze([
  wideHubFixture(),
  braidedRanksFixture(),
]);
