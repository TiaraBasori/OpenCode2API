export const Opencode2apiToolLock = async () => ({
    "permission.ask": async (_input, output) => {
        output.status = "deny"
    },
    "tool.execute.before": async (input) => {
        throw new Error('Tool "' + input.tool + '" is disabled by opencode2api')
    },
})
export default Opencode2apiToolLock
