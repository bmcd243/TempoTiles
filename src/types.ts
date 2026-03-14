export type IntervalStep = {
  id: string;
  label: string;
  durationSec: number;
};

export type IntervalBlock =
  | {
      type: "interval";
      id: string;
      label: string;
      durationSec: number;
    }
  | {
      type: "set";
      id: string;
      label: string;
      repeat: number;
      items: IntervalStep[];
    };
