// High-frequency household staples used by the MOV Smart Gap-Filler to bridge a
// basket that falls short of a platform's minimum-checkout or free-delivery
// threshold. These are the items a user is most likely to want anyway, so
// nudging one in to unlock free delivery is low-friction.
//
// NOTE: staples are currently derived from the live `products` table by matching
// these keywords against product names (see useStapleFillers). If/when the
// products schema gains a dedicated `is_staple` / high-frequency flag column,
// swap the keyword filter in the hook for a direct column filter — the rest of
// the pipeline (StapleItem → gap-filler engine) is agnostic to the source.
export const STAPLE_KEYWORDS: string[] = [
  'milk',
  'curd',
  'dahi',
  'bread',
  'egg',
  'butter',
  'paneer',
  'banana',
];
