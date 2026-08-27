type ModelMetadata = {
  contextWindow: number;
  supportsImages: boolean;
};

const modelMetadata = new Map<string, ModelMetadata>();

export function rememberModelMetadata(modelId: string, metadata: ModelMetadata) {
  modelMetadata.set(modelId, metadata);
}

export function getRememberedModelMetadata(modelId: string) {
  return modelMetadata.get(modelId);
}

