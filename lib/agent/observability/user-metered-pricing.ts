import { getSupabase } from "@/lib/platform/supabase";
import { meteredModelOptions, type MeteredModelCategory } from "./metered-models";

const TABLE = "user_metered_model_pricing";

type PricingRow = {
  category: MeteredModelCategory;
  model_id: string;
  input_price_cny: number | string;
  updated_at: string;
};

export type UserMeteredModelPrice = {
  category: MeteredModelCategory;
  modelId: string;
  modelName: string;
  inputPriceCnyPerMillionTokens: number | null;
  source: "database" | "static" | "unset";
  updatedAt?: string;
};

function key(category: MeteredModelCategory, modelId: string) {
  return `${category}:${modelId}`;
}

function isMissingSchema(error: { code?: string; message?: string } | null) {
  return error?.code === "42P01"
    || error?.code === "PGRST205"
    || error?.message?.includes(TABLE) === true;
}

export async function listUserMeteredModelPricing(
  userId: string,
): Promise<UserMeteredModelPrice[]> {
  const { data, error } = await getSupabase().from(TABLE)
    .select("category,model_id,input_price_cny,updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });
  if (error && !isMissingSchema(error)) throw new Error(`读取辅助模型价格失败: ${error.message}`);
  const rows = new Map(((data ?? []) as PricingRow[]).map((row) => [key(row.category, row.model_id), row]));
  const defaults = meteredModelOptions.map((model) => {
    const row = rows.get(key(model.category, model.id));
    return {
      category: model.category,
      modelId: model.id,
      modelName: model.name,
      inputPriceCnyPerMillionTokens: row ? Number(row.input_price_cny) : model.inputCnyPerMillionTokens,
      source: row ? "database" as const : "static" as const,
      updatedAt: row?.updated_at,
    };
  });
  const defaultKeys = new Set(defaults.map((model) => key(model.category, model.modelId)));
  const custom = ((data ?? []) as PricingRow[]).flatMap((row) =>
    defaultKeys.has(key(row.category, row.model_id)) ? [] : [{
      category: row.category,
      modelId: row.model_id,
      modelName: row.model_id,
      inputPriceCnyPerMillionTokens: Number(row.input_price_cny),
      source: "database" as const,
      updatedAt: row.updated_at,
    }]);
  return [...defaults, ...custom];
}

export async function updateUserMeteredModelPricing(input: {
  userId: string;
  prices: Array<{
    category: MeteredModelCategory;
    modelId: string;
    inputPriceCnyPerMillionTokens: number | null;
  }>;
}) {
  const supabase = getSupabase();
  for (const item of input.prices) {
    if (item.category !== "embedding" && item.category !== "rerank") {
      throw new Error("辅助模型类别无效");
    }
    const modelId = item.modelId.trim();
    if (!modelId || modelId.length > 180) throw new Error("辅助模型 ID 无效");
    const price = item.inputPriceCnyPerMillionTokens;
    if (price === null) {
      const { error } = await supabase.from(TABLE).delete()
        .eq("user_id", input.userId).eq("category", item.category).eq("model_id", modelId);
      if (error && !isMissingSchema(error)) throw new Error(`清除辅助模型价格失败: ${error.message}`);
      continue;
    }
    if (!Number.isFinite(price) || price < 0 || price > 1_000_000) {
      throw new Error(`${modelId} 的输入价格无效`);
    }
    const { error } = await supabase.from(TABLE).upsert({
      user_id: input.userId,
      category: item.category,
      model_id: modelId,
      input_price_cny: price,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,category,model_id" });
    if (isMissingSchema(error)) throw new Error("尚未创建辅助模型价格表，请先执行 20260829-user-metered-model-pricing.sql");
    if (error) throw new Error(`保存辅助模型价格失败: ${error.message}`);
  }
}

export async function resolveUserMeteredModelPrice(input: {
  userId: string;
  category: MeteredModelCategory;
  modelId: string;
}) {
  const prices = await listUserMeteredModelPricing(input.userId);
  return prices.find((item) => item.category === input.category && item.modelId === input.modelId)
    ?.inputPriceCnyPerMillionTokens ?? null;
}

