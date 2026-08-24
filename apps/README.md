# Applications

`apps` holds independently deployable application workloads.

- `web/` contains the three Next.js user interfaces.
- `services/` contains the backend runtimes and workers.

Shared code belongs in `packages/`; public schemas and protocol definitions stay in
`contracts/`. An application may depend on a contract, but should not copy one into
its own folder.
