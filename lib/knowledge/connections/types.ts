export type UserNotionConnectionView = {
  enabled: boolean;
  tokenConfigured: boolean;
  tokenHint: string;
  defaultRecursive: boolean;
  maxDepth: number;
  revision: number;
  updatedAt?: string;
  lastTestStatus?: "success" | "failed";
  lastTestError?: string;
  lastTestedAt?: string;
};

export type ResolvedUserNotionConnection = {
  enabled: true;
  token: string;
  defaultRecursive: boolean;
  maxDepth: number;
  revision: number;
};
