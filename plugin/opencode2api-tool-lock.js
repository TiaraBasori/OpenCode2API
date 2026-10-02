// OpenCode server plugin loaded by the backend that opencode2api starts.
//
// OpenCode Zen's free tier rejects any request whose tool list differs from
// the one the official client sends ("free tier can only be used from within
// OpenCode"). Disabling tools per request strips them from that list, so the
// proxy leaves the list alone and enforces its tool policy here, at execution
// time, instead.
//
// The policy is carried in the session title the proxy sets when it creates a
// session: "[tools:none]", "[tools:*]" or "[tools:webfetch,read]". Sessions
// without a policy (and failed lookups) deny every tool. Child sessions spawned
// by the task tool inherit the policy of their parent.

const POLICY = /\[tools:([^\]]*)\]/
const MAX_DEPTH = 8

const normalize = (name) => String(name || "").toLowerCase().replace(/[^a-z0-9./]/g, "")

const matches = (tool, name) => {
    const t = normalize(tool)
    const n = normalize(name)
    if (!t || !n) return false
    return t === n || t.endsWith("." + n) || t.endsWith("/" + n)
}

export const Opencode2apiToolLock = async ({ client }) => {
    const policyOf = async (sessionID) => {
        let id = sessionID
        for (let depth = 0; id && depth < MAX_DEPTH; depth++) {
            const res = await client.session.get({ path: { id } })
            const session = res?.data
            if (!session) return null
            const found = POLICY.exec(session.title || "")
            if (found) return found[1].trim()
            id = session.parentID
        }
        return null
    }

    return {
        "tool.execute.before": async (input, output) => {
            // External tools only exist as a text contract in the system prompt.
            // Models that call them natively land in OpenCode's "invalid" tool;
            // point them back to the contract instead of letting them flail.
            const requested = output?.args?.tool
            if (input.tool === "invalid" && typeof requested === "string" && requested.startsWith("external__")) {
                throw new Error(
                    `${requested} is not a native tool. Call it by replying with only ` +
                    `<function_calls>{"name":"${requested}","arguments":{...}}</function_calls>`
                )
            }

            let policy = null
            try {
                policy = await policyOf(input.sessionID)
            } catch {
                policy = null
            }
            if (policy === "*") return
            const allowed = policy && policy !== "none" ? policy.split(",") : []
            if (allowed.some((name) => matches(input.tool, name))) return
            throw new Error(`Tool "${input.tool}" is disabled by opencode2api. Do not call it again.`)
        },
    }
}

export default Opencode2apiToolLock
