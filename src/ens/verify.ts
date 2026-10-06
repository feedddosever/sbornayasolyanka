/**
 * Does an ENS name actually belong to the address using it?
 *
 * A listing or bid carries a display name ("acme.factor.eth"), and the
 * holder's signature proves they chose it — not that they own it. Anyone can
 * sign "trusted.factor.eth". So the server resolves the name on Sepolia and
 * records whether it points at the signer, and the market badges it.
 *
 * FLAG, NEVER BLOCK. An unverified name is still published, marked as such.
 * Blocking would turn a Sepolia RPC outage, or an ENSv2 beta change, into a
 * market where nobody can list; flagging keeps the market working and still
 * makes impersonation visible.
 */
import { normalize } from "viem/ens";
import { ENSV2 } from "./config";
import { sepoliaClient } from "./read";

export type Resolve = (name: string) => Promise<string | null>;

/** Forward resolution through the ENSv2 Universal Resolver. */
const resolveOnSepolia: Resolve = (name) =>
  sepoliaClient.getEnsAddress({
    name: normalize(name),
    universalResolverAddress: ENSV2.universalResolver as `0x${string}`,
  });

/**
 * True only when `name` resolves to `address` within `timeoutMs`. Empty names,
 * resolution failures and timeouts are all "unverified", never an error.
 */
export async function ensNameIsOwnedBy(
  name: string,
  address: string,
  { resolve = resolveOnSepolia, timeoutMs = 5_000 }: { resolve?: Resolve; timeoutMs?: number } = {},
): Promise<boolean> {
  if (!name) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const resolved = await Promise.race([
      resolve(name),
      new Promise<null>((r) => (timer = setTimeout(() => r(null), timeoutMs))),
    ]);
    return !!resolved && resolved.toLowerCase() === address.toLowerCase();
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
