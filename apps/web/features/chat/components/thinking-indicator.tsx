import styles from "./thinking-indicator.module.css";

export function ThinkingIndicator() {
  return (
    <div role="status" className="inline-flex h-8 items-center gap-1.5 px-1">
      <span className="sr-only">助手正在思考</span>
      <span className={styles.bar} aria-hidden="true" />
      <span className={styles.bar} aria-hidden="true" />
      <span className={styles.bar} aria-hidden="true" />
    </div>
  );
}
