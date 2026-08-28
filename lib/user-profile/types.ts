export const USER_PROFILE_MAX_CHARS = 8_000;

export type UserProfileView = {
  content: string;
  configured: boolean;
  revision: number;
  updatedAt?: string;
  maxChars: number;
};

export type UserProfileSnapshot = {
  content: string;
  configured: boolean;
  revision: number;
  updatedAt?: string;
};
