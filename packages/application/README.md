# @repo/application

Application use cases coordinate authenticated commands, Agent Runtime calls,
and persistence. They must not contain React components or Next.js route
exports. External services are still direct dependencies during step 2; step 3
will replace them with repository interfaces and infrastructure adapters.
