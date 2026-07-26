export type GroundingRequirementInput = {
  // 用户明确指定必须查询 Web/知识库时，即使模型漏调工具也不能绕过证据门禁。
  sourceEvidenceRequired?: boolean;
  // 实际成功执行的工具声明 citationRequired 时，回答必须验证其 EvidenceBundle。
  toolEvidenceRequired?: boolean;
};

// 请求级来源合同与执行期工具合同任一要求引用，Trace 中就必须记录证据校验结果。
export function requiresCitedEvidence(input: GroundingRequirementInput) {
  return input.sourceEvidenceRequired === true || input.toolEvidenceRequired === true;
}
