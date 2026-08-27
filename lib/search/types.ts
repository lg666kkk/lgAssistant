export type SearchProviderId = "tavily" | "exa" | "brave";

export type UserSearchProvider = {
  id: SearchProviderId;
  name: string;
  description: string;
  docsUrl: string;
  apiKeyConfigured: boolean;
  apiKeyHint: string;
  source: "database" | "environment" | "unset";
  enabled: boolean;
};

export type UserSearchCatalog = {
  providers: UserSearchProvider[];
  defaultProvider: SearchProviderId;
};

export type ResolvedSearchProvider = {
  id: SearchProviderId;
  apiKey: string;
};
