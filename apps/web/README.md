# Web Frontend

Browser-only code is organized by product feature:

- `features/chat`: chat components, hooks, and browser session state
- `features/knowledge`: knowledge-source and document-management UI
- `features/connections`: model and search-provider configuration UI
- `features/memory`: memory and user-profile UI
- `features/observability`: Trace and Langfuse UI
- `layout`: shared application shell components
- `lib`: browser-only infrastructure such as authenticated fetch and auth state

The Next.js `app/` directory remains at the repository root because it is the
framework routing adapter. Routes may import `@web/*`; browser code must not be
placed back into route directories.
