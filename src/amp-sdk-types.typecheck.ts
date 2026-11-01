import type { AmpOptions } from '@ampcode/sdk';

// The root zod override installs zod 4 for @agentclientprotocol/sdk, while
// @ampcode/sdk ships zod v3 types and its runtime bundle inlines zod v3.
// tsconfig maps the bare zod specifier to the v3 type surface so AmpOptions
// stays precise. If that mapping stops applying, AmpOptions widens to any and
// this directive becomes unused, failing the type check.
// @ts-expect-error cwd must remain the SDK schema's string option
const invalidAmpOptions: AmpOptions = { cwd: 1 };

void invalidAmpOptions;
