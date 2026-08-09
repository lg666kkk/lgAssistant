import type { MemoryType } from "./types";

/**
 * 受控 key 表：让高频槽位型事实收敛到同一个 key。
 *
 * 为什么需要它：写入判定的唯一可靠授权是「同一个业务 key」——语义相似度不能授权
 * UPDATE（购车预算 vs 首付预算、居住地 vs 工作地、喜欢香菜 vs 对香菜过敏，
 * 相似度都很高但槽位不同）。可是模型每轮自由造 key，同一个槽位可能一次叫
 * `budget:car`、一次叫 `car:budget`、一次叫 `buy-car:budget`，
 * 于是「同一 key」这个条件永远不成立，UPDATE 路径形同不存在，重复 active 照样长出来。
 *
 * 这张表是**治本**的那一半：让高频槽位每次都命中同一个 key。
 * 另一半是 memory-flow 里「歧义时 NOOP」的兜底，负责长尾。
 *
 * ⚠️ 刻意不是闭集：未命中受控表的事实**仍然允许自由 key**。
 * 个人助理面对的事实是开放域的，枚举覆盖不了长尾，硬拒绝等于直接丢事实。
 */
export const CONTROLLED_MEMORY_KEYS = {
  // ── 金额类槽位：最容易被语义相似度错误合并的一类 ──────────────
  "budget:car": { label: "购车预算", type: "fact" },
  "budget:car:down_payment": { label: "购车首付预算", type: "fact" },
  "budget:housing": { label: "住房预算", type: "fact" },
  "budget:housing:down_payment": { label: "购房首付预算", type: "fact" },
  "budget:travel": { label: "旅行预算", type: "fact" },

  // ── 地点类槽位 ────────────────────────────────────────
  "location:residence": { label: "居住地", type: "profile" },
  "location:workplace": { label: "工作地", type: "profile" },
  "location:hometown": { label: "家乡", type: "profile" },

  // ── 身份与职业 ────────────────────────────────────────
  "profile:occupation": { label: "职业", type: "profile" },
  "profile:employer": { label: "所属公司或组织", type: "profile" },
  "profile:language": { label: "偏好使用的语言", type: "preference" },
  "profile:timezone": { label: "所在时区", type: "profile" },

  // ── 饮食：喜好是多值集合，使用动态 key `diet:food:<具体食物>` ──────
  // 不能把所有喜欢的食物压进一个 `diet:preference`：那会让土豆和香菜互相覆盖。
  // 禁忌和过敏仍是独立槽位，绝不能被普通喜好覆盖。
  "diet:restriction": { label: "饮食禁忌（不吃什么）", type: "preference" },
  "diet:allergy": { label: "食物过敏（吃了会出事）", type: "fact" },

  // ── 工作方式偏好 ──────────────────────────────────────
  "preference:communication_style": { label: "沟通与回答风格偏好", type: "preference" },
  "preference:tech_stack": { label: "技术栈偏好", type: "preference" },
  "preference:code_style": { label: "代码风格偏好", type: "preference" },
} as const satisfies Record<string, { label: string; type: MemoryType }>;

export type ControlledMemoryKey = keyof typeof CONTROLLED_MEMORY_KEYS;

export function isControlledMemoryKey(key: string): key is ControlledMemoryKey {
  return Object.prototype.hasOwnProperty.call(CONTROLLED_MEMORY_KEYS, key);
}

/**
 * 渲染进抽取 prompt 的清单。
 * 带上 label 而不只给 key：模型看 `budget:car:down_payment` 猜不出它和
 * `budget:car` 的分工，看到「购车首付预算 / 购车预算」才能选对。
 */
export function renderControlledKeyList() {
  return Object.entries(CONTROLLED_MEMORY_KEYS)
    .map(([key, meta]) => `- ${key}：${meta.label}`)
    .join("\n");
}
