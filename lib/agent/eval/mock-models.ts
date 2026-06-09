export function createCalculatorToolThenAnswerModel() {
  let turn = 0;

  return async () => {
    turn++;

    if (turn === 1) {
      return {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "calculator",
            input: { expression: "123*456" },
          },
        ],
      };
    }

    return {
      content: [{ type: "text", text: "结果是 56088" }],
    };
  };
}
