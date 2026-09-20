import { integration } from "@porkbot/testkit";

// The canary's live tier: the same runner the nightly workflow runs, against
// the real Docker daemon the integration tier boots the local stack with. The
// emulator proves the rules; this proves the provider seam on a real machine.
export default integration({ include: ["test/integration/**/*.integration.test.ts"] });
