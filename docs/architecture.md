# Architecture

This repository is intentionally organized as a single Pi package. It keeps resource discovery predictable while allowing each resource type to evolve independently.

```text
package.json
    |
    +-- pi.extensions --> extensions/
    +-- pi.skills     --> skills/
    +-- pi.prompts    --> prompts/
    +-- pi.themes     --> themes/
```

An extension is executable TypeScript and should own only one coherent integration. Skills, prompts and themes are declarative resources and should not be coupled to extension internals unless the coupling is documented.

When the repository grows, add a subdirectory for a multi-file feature instead of creating shared global state. A nested `AGENTS.md` may be added for a genuinely independent area, but it must not contradict the root safety and validation rules.
