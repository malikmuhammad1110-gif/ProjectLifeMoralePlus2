// lib/scoring.ts
export type Answer = { score?: number; scenarioScore?: number; note?: string };
export type TimeCategory =
  | "Sleep" | "Work" | "Commute" | "Relationships" | "Leisure"
  | "Gym" | "Chores" | "Growth" | "Other";
export type TimeRow = { category: TimeCategory; hours: number; ri: number };
export type DimensionKey = "Fulfillment" | "Connection" | "Autonomy" | "Vitality" | "Peace";

export type Input = {
  answers: Answer[];      // 24 items, 1–10
  timeMap: TimeRow[];     // 9 categories, hours per week
  ELI: number;            // 1–10 (1 = baseline)
  config?: Partial<Config>;
};

export type Output = {
  calibrated: { current: number[]; scenario: (number | undefined)[] };
  sectionAverages: {
    current: Record<DimensionKey, number | null>;
    scenario: Record<DimensionKey, number | null>;
  };
  rawLMS: number;
  riAdjusted: number;
  finalLMI: number;
  rawLMS_scn: number;
  riAdjusted_scn: number;
  finalLMI_scn: number;
  topDrainers: { index: number; score: number; note?: string }[];
  topUplifters: { index: number; score: number; note?: string }[];
};

export type Config = {
  calibration: { k: number; max: number };      // 10 → max (default 8.75)
  ri: { globalMultiplier: number };             // default 1
  crossLift: { enabled: boolean; alpha: number }; // optional spillover to Work
};

const DEFAULT_CONFIG: Config = {
  calibration: { k: 1.936428228, max: 8.75 },
  ri: { globalMultiplier: 1 },
  crossLift: { enabled: false, alpha: 20 },
};

const DIM_MAP: Record<DimensionKey, number[]> = {
  Fulfillment: [0, 1, 2, 3, 4],
  Connection:  [5, 6, 7, 8, 9],
  Autonomy:    [10,11,12,13,14],
  Vitality:    [15,16,17,18,19],
  Peace:       [20,21,22,23],
};

function riToInternal(ri?: number) {
  if (ri == null) return 0;
  if (ri < 5)  return (ri - 5) * 0.075; // 1 -> -0.30
  if (ri === 5) return 0;
  return (ri - 5) * 0.06;               // 10 -> +0.30
}

function calibrate(s?: number, k = 1.936428228, max = 8.75) {
  if (s == null) return undefined;
  const x = Math.max(1, Math.min(10, s));
  const num = 1 - Math.exp(-k * (x / 10));
  const den = 1 - Math.exp(-k);
  return max * (num / den);
}

function avg(nums: (number | undefined)[]) {
  const v = nums.filter((n): n is number => typeof n === "number" && !Number.isNaN(n));
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function qualityFromSections(
  d: Record<DimensionKey, number | null>,
  base: number | null
) {
  return {
    Work: d.Autonomy ?? base ?? 0,
    Commute: d.Peace ?? base ?? 0,
    Gym: d.Vitality ?? base ?? 0,
    Relationships: d.Connection ?? base ?? 0,
    Leisure: d.Fulfillment ?? base ?? 0,
    Other: base ?? 0,
  };
}

export function scoreLMI(input: Input): Output {
  const cfg: Config = {
    calibration: input.config?.calibration ?? DEFAULT_CONFIG.calibration,
    ri: input.config?.ri ?? DEFAULT_CONFIG.ri,
    crossLift: input.config?.crossLift ?? DEFAULT_CONFIG.crossLift,
  };

  // 1) Calibrate answers (10 → 8.75 ceiling, lifts mid-range)
  const current = input.answers.map(a => calibrate(a.score, cfg.calibration.k, cfg.calibration.max));
  const scenario = input.answers.map(a => calibrate(a.scenarioScore, cfg.calibration.k, cfg.calibration.max));

  // 2) Section averages
  const sectionCurrent: Record<DimensionKey, number | null> = {
    Fulfillment: avg(DIM_MAP.Fulfillment.map(i => current[i])),
    Connection:  avg(DIM_MAP.Connection.map(i => current[i])),
    Autonomy:    avg(DIM_MAP.Autonomy.map(i => current[i])),
    Vitality:    avg(DIM_MAP.Vitality.map(i => current[i])),
    Peace:       avg(DIM_MAP.Peace.map(i => current[i])),
  };
  const sectionScenario: Record<DimensionKey, number | null> = {
    Fulfillment: avg(DIM_MAP.Fulfillment.map(i => scenario[i])),
    Connection:  avg(DIM_MAP.Connection.map(i => scenario[i])),
    Autonomy:    avg(DIM_MAP.Autonomy.map(i => scenario[i])),
    Vitality:    avg(DIM_MAP.Vitality.map(i => scenario[i])),
    Peace:       avg(DIM_MAP.Peace.map(i => scenario[i])),
  };

  const baseAvgAll = avg(current);
  const baseAvgAll_scn = avg(scenario);

  // 3) Time map defaults
  const find = (c: TimeCategory) =>
    input.timeMap.find(r => r.category === c) ??
    { category: c, hours: c === "Sleep" ? 49 : 0, ri: 5 };

  const by = {
    Sleep: find("Sleep"),
    Work: find("Work"),
    Commute: find("Commute"),
    Relationships: find("Relationships"),
    Leisure: find("Leisure"),
    Gym: find("Gym"),
    Chores: find("Chores"),
    Growth: find("Growth"),
    Other: find("Other"),
  };

  const awakeHours = Math.max(0, 168 - by.Sleep.hours);
  const otherAwake =
    Math.max(0, awakeHours - (by.Work.hours + by.Commute.hours + by.Gym.hours + by.Relationships.hours + by.Leisure.hours));

  const dimQ = qualityFromSections(sectionCurrent, baseAvgAll);
  const dimQ_s = qualityFromSections(sectionScenario, baseAvgAll_scn ?? baseAvgAll);

  let workQ = dimQ.Work;
  if (cfg.crossLift.enabled) {
    const relFrac = awakeHours ? by.Relationships.hours / awakeHours : 0;
    const gymFrac = awakeHours ? by.Gym.hours / awakeHours : 0;
    const leisFrac = awakeHours ? by.Leisure.hours / awakeHours : 0;
    const relRI = Math.max(0, riToInternal(by.Relationships.ri));
    const gymRI = Math.max(0, riToInternal(by.Gym.ri));
    const leisRI = Math.max(0, riToInternal(by.Leisure.ri));
    const uplift = cfg.crossLift.alpha * (relFrac * relRI + gymFrac * gymRI + leisFrac * leisRI) * ((10 - workQ) / 10);
    workQ = Math.min(10, Math.max(1, workQ + uplift));
  }

  const commuteQ = dimQ.Commute;
  const gymQ = dimQ.Gym;
  const relQ = dimQ.Relationships;
  const leisQ = dimQ.Leisure;
  const otherQ = dimQ.Other;

  const awakeWeighted =
    (by.Work.hours * workQ +
      by.Commute.hours * commuteQ +
      by.Gym.hours * gymQ +
      by.Relationships.hours * relQ +
      by.Leisure.hours * leisQ +
      otherAwake * otherQ) /
    (awakeHours || 1);

  const sleepQ = (10 + awakeWeighted) / 2;

  const rawLMS =
    (by.Work.hours * workQ +
      by.Commute.hours * commuteQ +
      by.Gym.hours * gymQ +
      by.Relationships.hours * relQ +
      by.Leisure.hours * leisQ +
      otherAwake * otherQ +
      by.Sleep.hours * sleepQ) / 168;

  const netRI =
    (by.Work.hours / 168) * riToInternal(by.Work.ri) +
    (by.Commute.hours / 168) * riToInternal(by.Commute.ri) +
    (by.Gym.hours / 168) * riToInternal(by.Gym.ri) +
    (by.Relationships.hours / 168) * riToInternal(by.Relationships.ri) +
    (by.Leisure.hours / 168) * riToInternal(by.Leisure.ri) +
    (otherAwake / 168) * riToInternal(by.Other.ri);

  const riAdjusted = rawLMS * (1 + (input.config?.ri?.globalMultiplier ?? 1) * netRI);

  const LMC = 10 - 0.2 * (input.ELI ?? 1);
  const finalLMI = riAdjusted * (LMC / 10);

  // Scenario (same hours/RI, different qualities if provided)
  let workQ_s = dimQ_s.Work ?? workQ;
  if (cfg.crossLift.enabled) {
    const relFrac = awakeHours ? by.Relationships.hours / awakeHours : 0;
    const gymFrac = awakeHours ? by.Gym.hours / awakeHours : 0;
    const leisFrac = awakeHours ? by.Leisure.hours / awakeHours : 0;
    const relRI = Math.max(0, riToInternal(by.Relationships.ri));
    const gymRI = Math.max(0, riToInternal(by.Gym.ri));
    const leisRI = Math.max(0, riToInternal(by.Leisure.ri));
    const uplift = cfg.crossLift.alpha * (relFrac * relRI + gymFrac * gymRI + leisFrac * leisRI) * ((10 - workQ_s) / 10);
    workQ_s = Math.min(10, Math.max(1, workQ_s + uplift));
  }

  const commuteQ_s = dimQ_s.Commute ?? commuteQ;
  const gymQ_s = dimQ_s.Gym ?? gymQ;
  const relQ_s = dimQ_s.Relationships ?? relQ;
  const leisQ_s = dimQ_s.Leisure ?? leisQ;
  const otherQ_s = dimQ_s.Other ?? otherQ;

  const awakeWeighted_s =
    (by.Work.hours * workQ_s +
      by.Commute.hours * commuteQ_s +
      by.Gym.hours * gymQ_s +
      by.Relationships.hours * relQ_s +
      by.Leisure.hours * leisQ_s +
      otherAwake * otherQ_s) /
    (awakeHours || 1);

  const sleepQ_s = (10 + awakeWeighted_s) / 2;

  const rawLMS_s =
    (by.Work.hours * workQ_s +
      by.Commute.hours * commuteQ_s +
      by.Gym.hours * gymQ_s +
      by.Relationships.hours * relQ_s +
      by.Leisure.hours * leisQ_s +
      otherAwake * otherQ_s +
      by.Sleep.hours * sleepQ_s) / 168;

  const riAdjusted_s = rawLMS_s * (1 + (input.config?.ri?.globalMultiplier ?? 1) * netRI);
  const finalLMI_s = riAdjusted_s * (LMC / 10);

  const baseScores = input.answers.map(a => a.score ?? NaN);
  const idxs = baseScores.map((s, i) => ({ i, s })).filter(x => !Number.isNaN(x.s));
  const drains = [...idxs].sort((a, b) => a.s - b.s).slice(0, 3).map(x => ({ index: x.i, score: x.s, note: input.answers[x.i].note }));
  const lifts  = [...idxs].sort((a, b) => b.s - a.s).slice(0, 3).map(x => ({ index: x.i, score: x.s, note: input.answers[x.i].note }));

  return {
    calibrated: { current: current as number[], scenario },
    sectionAverages: { current: sectionCurrent, scenario: sectionScenario },
    rawLMS, riAdjusted, finalLMI,
    rawLMS_scn, riAdjusted_scn, finalLMI_scn,
    topDrainers: drains, topUplifters: lifts,
  };
}
