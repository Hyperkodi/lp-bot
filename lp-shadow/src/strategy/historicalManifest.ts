export type HistoricalCohort = 'TRAINING' | 'HOLDOUT';
export type HistoricalOutcomeStratum = 'CRASH' | 'MIDDLE' | 'WINNER';

export type HistoricalLaunch = {
  name: string;
  address: string;
  createdAtMs: number;
  capturedReturnPct: number;
  cohort: HistoricalCohort;
  stratum: HistoricalOutcomeStratum;
};

/**
 * Frozen 2026-08-14 from repeated creation-ordered SOL-pool scans. Pools were
 * eligible with at least 116 of 145 first-72h 30-minute candles. This is a
 * deliberately outcome-stratified stress cohort, not a population estimate.
 */
export const HISTORICAL_LAUNCHES: readonly HistoricalLaunch[] = Object.freeze([
  { name: 'Ferret-SOL', address: '8qKDGxmHzcZVnvScg3ecwmy7FC7fG62TxB9jKrBBoaHC', createdAtMs: 1785256510000, capturedReturnPct: -96.8, cohort: 'TRAINING', stratum: 'CRASH' },
  { name: 'TINYTANK-SOL', address: 'BG8uSxNdvWVaJSC6a4ZWHvrRifNwgvVvoL39Vd31dwY2', createdAtMs: 1786037269000, capturedReturnPct: -93.71, cohort: 'HOLDOUT', stratum: 'CRASH' },
  { name: 'CLAWD-SOL', address: 'AgLdqY9ySvU9hsBSMBx6EXRYB5PyJ6mGbmAXCjfh2vv', createdAtMs: 1785962023000, capturedReturnPct: -93.05, cohort: 'TRAINING', stratum: 'CRASH' },
  { name: 'Cheshire-SOL', address: '2Jei7fvSRJjnTTRuNowL8QBQeTpRNo6e3HQnbSUeBJnm', createdAtMs: 1785528487000, capturedReturnPct: -88.57, cohort: 'HOLDOUT', stratum: 'CRASH' },
  { name: 'HORSE-SOL', address: '8E4t2JxBiB4YNwcgMrNHR2Eyb7xL433i8Z2fTiLXeAF5', createdAtMs: 1785018248000, capturedReturnPct: -86.47, cohort: 'TRAINING', stratum: 'CRASH' },
  { name: 'HTZ-SOL', address: '3HVfnFjpg1Spogopcuh1fxwSawjgYsi3NPgqhqUo5sA1', createdAtMs: 1786105476000, capturedReturnPct: -83.65, cohort: 'HOLDOUT', stratum: 'CRASH' },
  { name: 'RISE-SOL', address: '5GVh5uc1Vx3LeNRysYrqpvGUJ8EXs91EDz7zbuvHfEE2', createdAtMs: 1784437445000, capturedReturnPct: -79.24, cohort: 'TRAINING', stratum: 'CRASH' },
  { name: 'Rigby-SOL', address: '5LEmVn4yBkbCkdUnRvCd5Ks7pzHGALpJV5sGrBsUHxTo', createdAtMs: 1784595534000, capturedReturnPct: -77.8, cohort: 'HOLDOUT', stratum: 'CRASH' },

  { name: 'Gnomes-SOL', address: 'AmSwRUXiUb8GWf8Pm1ieeGj1TKRyvdgBrQJkyRk4APcJ', createdAtMs: 1785319224000, capturedReturnPct: -70.12, cohort: 'TRAINING', stratum: 'MIDDLE' },
  { name: 'EPIK-SOL', address: '68hMvRQRHCRs4heTdPkdatZmGWfKrdr6YxYXSfs8EoKX', createdAtMs: 1785147466000, capturedReturnPct: -63.36, cohort: 'HOLDOUT', stratum: 'MIDDLE' },
  { name: 'CLANKER-SOL', address: 'FfoCDxdeXGs4K4G9TP4BwJVRaPpXUY1B7cVURMthLWdb', createdAtMs: 1786131833000, capturedReturnPct: -56.47, cohort: 'TRAINING', stratum: 'MIDDLE' },
  { name: 'KIO-SOL', address: 'HnrKCMEMXQjN9Fmmh96U3djD2mdKMDDybvn56HfCdv5q', createdAtMs: 1785942209000, capturedReturnPct: -35.32, cohort: 'HOLDOUT', stratum: 'MIDDLE' },
  { name: 'BUTTHOLE-SOL', address: 'Gfydo5NxAfj3ayEJbvb4kotrrtH3MJyEXdCreKt4SqdA', createdAtMs: 1786130102000, capturedReturnPct: -34.55, cohort: 'TRAINING', stratum: 'MIDDLE' },
  { name: 'PLONK-SOL', address: 'CnmBsUJYbi4qNpgzFGRJG4hDdrNuAi3L1vom4X6fRUF8', createdAtMs: 1785873935000, capturedReturnPct: -3.91, cohort: 'HOLDOUT', stratum: 'MIDDLE' },
  { name: 'BAYLA-SOL', address: '9kBy5ryTdu5aixzYpp7HxyGBUBoqGgwvGFjmsuak3Cwq', createdAtMs: 1786121553000, capturedReturnPct: 11.57, cohort: 'TRAINING', stratum: 'MIDDLE' },
  { name: 'YOTS-SOL', address: 'GFJxt2P2qUVbX9b14uuBQZHrdmhEV6Q618qvGnwdsX2L', createdAtMs: 1785372582000, capturedReturnPct: 11.83, cohort: 'HOLDOUT', stratum: 'MIDDLE' },

  { name: 'Chonketha-SOL', address: '6PBSpk7VkSdEMWWT9SkGjgZqSyWfeqGEaFMp9U1Aur8y', createdAtMs: 1785600462000, capturedReturnPct: 51.22, cohort: 'TRAINING', stratum: 'WINNER' },
  { name: 'looong-SOL', address: 'GMcDowNwC6yozAeZZHgJWMmH7gUpudDq55C84uv1WQkn', createdAtMs: 1784830110000, capturedReturnPct: 69.45, cohort: 'HOLDOUT', stratum: 'WINNER' },
  { name: 'Doom-SOL', address: 'CYnphDZj1ZT32vw5zk7bSAeVSWUoGghhrBTmiaHH1CdJ', createdAtMs: 1785789237000, capturedReturnPct: 105.55, cohort: 'TRAINING', stratum: 'WINNER' },
  { name: 'MEMIPEDE-SOL', address: 'AcLZsWDzsEqeQbKo9jmPtv2BiRfoTFQUpoUPY7c9AeKL', createdAtMs: 1784503520000, capturedReturnPct: 106.76, cohort: 'HOLDOUT', stratum: 'WINNER' },
  { name: '3place-SOL', address: '8uKYXnmB8xQDyirQuy1tNzKeabCUajCcNz5VzxJfRYKZ', createdAtMs: 1785593814000, capturedReturnPct: 277.81, cohort: 'TRAINING', stratum: 'WINNER' },
  { name: 'lmeow-SOL', address: 'AUWQfR83jfWgUtvoMLyjMccHiMCokA1oSLvf9ghbQwJn', createdAtMs: 1785771543000, capturedReturnPct: 123.89, cohort: 'HOLDOUT', stratum: 'WINNER' },
  { name: 'CATE-SOL', address: 'BCEKtAL38iBUzXDJw1kHp3V2fdCW6fQmoVah3GZBgJLA', createdAtMs: 1785084847000, capturedReturnPct: 2396.39, cohort: 'TRAINING', stratum: 'WINNER' },
  { name: 'STONK-SOL', address: '3C6qVymTAwWNKCSspmd1qbUH9avaqhsjgW2yntvEYBXt', createdAtMs: 1785715697000, capturedReturnPct: 3494.96, cohort: 'HOLDOUT', stratum: 'WINNER' },
]);
