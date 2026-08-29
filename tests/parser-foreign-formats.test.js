import { describe, expect, test } from '@jest/globals';
import { buildExternalToolRegistry } from '../src/tool-runtime/registry.js';
import {
    parseExternalToolCallsFromText,
    stripFunctionCallMarkup,
    createToolCallFilter,
    createExternalToolCallStreamParser
} from '../src/tool-runtime/parser.js';

/**
 * Every fixture in this file is verbatim output captured from OpenCode free models
 * (deepseek-v4-flash-free / big-pickle) running through the proxy-bridge tool mode.
 * These models ignore the instructed <function_calls> contract and emit their own
 * native or invented markup, which used to be dropped entirely.
 */

const registry = buildExternalToolRegistry([
    {
        type: 'function',
        function: {
            name: 'bash',
            description: 'Run a shell command',
            parameters: {
                type: 'object',
                properties: { command: { type: 'string' }, description: { type: 'string' } },
                required: ['command']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'read',
            description: 'Read a file',
            parameters: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] }
        }
    }
]);

const firstCall = (calls) => {
    expect(calls.length).toBeGreaterThan(0);
    return { name: calls[0].function.name, args: JSON.parse(calls[0].function.arguments) };
};

describe('canonical <function_calls> format still works', () => {
    test('parses single call', () => {
        const text = '<function_calls>{"name":"external__bash","arguments":{"command":"ls -la"}}</function_calls>';
        const { name, args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(name).toBe('bash');
        expect(args).toEqual({ command: 'ls -la' });
    });

    test('parses array payload', () => {
        const text = '<function_calls>[{"name":"external__bash","arguments":{"command":"pwd"}},{"name":"external__read","arguments":{"file":"a.txt"}}]</function_calls>';
        const calls = parseExternalToolCallsFromText(registry, text);
        expect(calls.map((c) => c.function.name)).toEqual(['bash', 'read']);
    });

    test('strips canonical markup', () => {
        const text = 'before <function_calls>{"name":"external__bash","arguments":{}}</function_calls> after';
        expect(stripFunctionCallMarkup(text)).toBe('before  after');
    });
});

describe('DSML format (DeepSeek native)', () => {
    const dsml = [
        '<｜｜DSML｜｜tool_calls>',
        '<｜｜DSML｜｜invoke name="external__bash">',
        '<｜｜DSML｜｜parameter name="command" string="true">ls -la</｜｜DSML｜｜parameter>',
        '</｜｜DSML｜｜invoke>',
        '</｜｜DSML｜｜tool_calls>'
    ].join('\n');

    test('parses single-parameter invoke', () => {
        const { name, args } = firstCall(parseExternalToolCallsFromText(registry, dsml));
        expect(name).toBe('bash');
        expect(args).toEqual({ command: 'ls -la' });
    });

    test('parses multi-parameter invoke with un-namespaced tool name', () => {
        const text = [
            '<｜｜DSML｜｜tool_calls>',
            '<｜｜DSML｜｜invoke name="bash">',
            '<｜｜DSML｜｜parameter name="command" string="true">cat sample.txt</｜｜DSML｜｜parameter>',
            '<｜｜DSML｜｜parameter name="description" string="true">Read sample.txt contents</｜｜DSML｜｜parameter>',
            '</｜｜DSML｜｜invoke>',
            '</｜｜DSML｜｜tool_calls>'
        ].join('\n');
        const { name, args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(name).toBe('bash');
        expect(args).toEqual({ command: 'cat sample.txt', description: 'Read sample.txt contents' });
    });

    test('parses multiple invokes in one block', () => {
        const text = [
            '<｜｜DSML｜｜tool_calls>',
            '<｜｜DSML｜｜invoke name="bash">',
            '<｜｜DSML｜｜parameter name="command" string="true">pwd</｜｜DSML｜｜parameter>',
            '</｜｜DSML｜｜invoke>',
            '<｜｜DSML｜｜invoke name="read">',
            '<｜｜DSML｜｜parameter name="file" string="true">a.txt</｜｜DSML｜｜parameter>',
            '</｜｜DSML｜｜invoke>',
            '</｜｜DSML｜｜tool_calls>'
        ].join('\n');
        const calls = parseExternalToolCallsFromText(registry, text);
        expect(calls.map((c) => c.function.name)).toEqual(['bash', 'read']);
    });

    test('preserves multi-line parameter values verbatim', () => {
        const text = [
            '<｜｜DSML｜｜tool_calls>',
            '<｜｜DSML｜｜invoke name="bash">',
            '<｜｜DSML｜｜parameter name="command" string="true">line1',
            'line2  ',
            '  line3</｜｜DSML｜｜parameter>',
            '</｜｜DSML｜｜invoke>',
            '</｜｜DSML｜｜tool_calls>'
        ].join('\n');
        const { args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(args.command).toBe('line1\nline2  \n  line3');
    });

    test('coerces non-string parameters when string flag is absent', () => {
        const text = [
            '<｜｜DSML｜｜tool_calls>',
            '<｜｜DSML｜｜invoke name="bash">',
            '<｜｜DSML｜｜parameter name="command" string="true">ls</｜｜DSML｜｜parameter>',
            '<｜｜DSML｜｜parameter name="timeout">30</｜｜DSML｜｜parameter>',
            '</｜｜DSML｜｜invoke>',
            '</｜｜DSML｜｜tool_calls>'
        ].join('\n');
        const { args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(args.timeout).toBe(30);
    });

    test('strips DSML markup from text without a registry', () => {
        expect(stripFunctionCallMarkup(`answer\n${dsml}`)).toBe('answer');
    });

    test('parses generic invoke/parameter markup without DSML delimiters', () => {
        const text = [
            '<invoke name="bash">',
            '<parameter name="command">echo hi</parameter>',
            '</invoke>'
        ].join('\n');
        const { name, args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(name).toBe('bash');
        expect(args).toEqual({ command: 'echo hi' });
    });
});

describe('<tool_call> JSON wrapper format', () => {
    test('parses name/arguments payload', () => {
        const text = '<tool_call>\n{"name":"external__bash","arguments":{"command":"ls"}}\n</tool_call>';
        const { name, args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(name).toBe('bash');
        expect(args).toEqual({ command: 'ls' });
    });

    test('parses OpenAI-shaped function payload', () => {
        const text = '<tool_call>{"function":{"name":"read","arguments":{"file":"x.txt"}}}</tool_call>';
        const { name, args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(name).toBe('read');
        expect(args).toEqual({ file: 'x.txt' });
    });

    test('parses stringified arguments', () => {
        const text = '<tool_call>{"name":"bash","arguments":"{\\"command\\":\\"pwd\\"}"}</tool_call>';
        const { args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(args).toEqual({ command: 'pwd' });
    });

    test('handles tool_calls alias wrapper', () => {
        const text = '<tool_calls>{"name":"bash","arguments":{"command":"id"}}</tool_calls>';
        const { name } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(name).toBe('bash');
    });

    test('strips wrapper markup without a registry', () => {
        const text = 'ok\n<tool_call>{"name":"bash","arguments":{}}</tool_call>';
        expect(stripFunctionCallMarkup(text)).toBe('ok');
    });
});

describe('tag-named formats', () => {
    test('parses self-closing tag with JSON attribute', () => {
        const text = `<external__bash arguments='{"command":"ls -la"}' name="external__bash"/>`;
        const { name, args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(name).toBe('bash');
        expect(args).toEqual({ command: 'ls -la' });
    });

    // Observed live: the JSON attribute value carries no surrounding quotes.
    test('parses unquoted JSON attribute', () => {
        const text = '<external__bash name="external__bash" arguments={"command":"ls"} />';
        const { name, args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(name).toBe('bash');
        expect(args).toEqual({ command: 'ls' });
    });

    test('parses unquoted JSON attribute whose value contains a redirect', () => {
        const text = '<external__bash arguments={"command":"ls > out.txt"} />';
        const { name, args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(name).toBe('bash');
        expect(args).toEqual({ command: 'ls > out.txt' });
    });

    test('parses quoted JSON attribute whose value contains a redirect', () => {
        const text = `<external__bash arguments='{"command":"ls > out.txt"}' />`;
        const { args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(args).toEqual({ command: 'ls > out.txt' });
    });

    test('strips an unquoted JSON attribute tag from visible text', () => {
        const text = 'before <external__bash arguments={"command":"ls"} /> after';
        expect(stripFunctionCallMarkup(text, true, { registry })).toBe('before  after');
    });

    test('parses tag with quoted description and JSON body', () => {
        const text = '<external__bash "Run a shell command">\n{"command":"ls -la"}';
        const { name, args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(name).toBe('bash');
        expect(args).toEqual({ command: 'ls -la' });
    });

    test('parses tag wrapping a <parameters> JSON block inside prose', () => {
        const text = [
            '<details>',
            '<summary>Running ls to list files</summary>',
            '<external__bash>',
            '<parameters>',
            '{',
            '  "command": "ls -la"',
            '}',
            '</parameters>',
            '</external__bash>',
            '</details>'
        ].join('\n');
        const { name, args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(name).toBe('bash');
        expect(args).toEqual({ command: 'ls -la' });
    });

    test('parses closed tag with direct JSON body', () => {
        const text = '<external__read>{"file":"notes.md"}</external__read>';
        const { name, args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(name).toBe('read');
        expect(args).toEqual({ file: 'notes.md' });
    });

    test('ignores tags that are not registered tools', () => {
        const text = '<summary>{"command":"rm -rf /"}</summary>';
        expect(parseExternalToolCallsFromText(registry, text)).toEqual([]);
    });

    test('leaves unrelated html untouched when stripping', () => {
        const text = 'see <details>more</details> here';
        expect(stripFunctionCallMarkup(text, true, { registry })).toBe('see <details>more</details> here');
    });
});

/**
 * Cline/Roo-style markup, where each argument is its own XML child element. Captured live
 * from deepseek-v4-flash-free: `<read>\n<path>a.txt</path>\n</read>`. The tag was matched
 * but the children were discarded, producing a call with empty arguments that then failed
 * schema validation for any tool with required fields.
 */
describe('XML child element arguments', () => {
    const xmlRegistry = buildExternalToolRegistry([
        {
            type: 'function',
            name: 'read',
            description: 'Read a file',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    offset: { type: 'number' },
                    recursive: { type: 'boolean' }
                },
                required: ['path']
            }
        },
        {
            type: 'function',
            name: 'bash',
            description: 'Run a command',
            parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
        }
    ]);

    test('parses a single child element on its own line', () => {
        const text = '<read>\n<path>a.txt</path>\n</read>';
        const { name, args } = firstCall(parseExternalToolCallsFromText(xmlRegistry, text));
        expect(name).toBe('read');
        expect(args).toEqual({ path: 'a.txt' });
    });

    test('parses multiple children and coerces by declared schema type', () => {
        const text = '<read><path>a.txt</path><offset>10</offset><recursive>true</recursive></read>';
        const { args } = firstCall(parseExternalToolCallsFromText(xmlRegistry, text));
        expect(args).toEqual({ path: 'a.txt', offset: 10, recursive: true });
    });

    test('keeps a numeric-looking string argument as a string', () => {
        const text = '<read><path>123.txt</path></read>';
        const { args } = firstCall(parseExternalToolCallsFromText(xmlRegistry, text));
        expect(args).toEqual({ path: '123.txt' });
        expect(typeof args.path).toBe('string');
    });

    test('accepts the namespaced tag name', () => {
        const text = '<external__read><path>/tmp/x.log</path></external__read>';
        const { name, args } = firstCall(parseExternalToolCallsFromText(xmlRegistry, text));
        expect(name).toBe('read');
        expect(args).toEqual({ path: '/tmp/x.log' });
    });

    test('preserves a redirect inside a child element value', () => {
        const text = '<bash><command>ls > out.txt</command></bash>';
        const { args } = firstCall(parseExternalToolCallsFromText(xmlRegistry, text));
        expect(args).toEqual({ command: 'ls > out.txt' });
    });

    test('ignores child elements that are not declared in the schema', () => {
        const text = '<read><path>a.txt</path><rm_rf>/</rm_rf></read>';
        const { args } = firstCall(parseExternalToolCallsFromText(xmlRegistry, text));
        expect(args).toEqual({ path: 'a.txt' });
    });

    test('strips the markup from visible text', () => {
        const text = 'Let me look: <read>\n<path>a.txt</path>\n</read>';
        expect(stripFunctionCallMarkup(text, true, { registry: xmlRegistry })).toBe('Let me look:');
    });

    test('still yields empty arguments when the body has no recognizable children', () => {
        const text = '<read>just some prose</read>';
        const { args } = firstCall(parseExternalToolCallsFromText(xmlRegistry, text));
        expect(args).toEqual({});
    });
});

describe('bare JSON format', () => {
    test('parses whole-body JSON object', () => {
        const text = '{"name":"external__bash","arguments":{"command":"ls"}}';
        const { name, args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(name).toBe('bash');
        expect(args).toEqual({ command: 'ls' });
    });

    test('parses whole-body JSON wrapped in a fenced code block', () => {
        const text = '```json\n{"name":"bash","arguments":{"command":"ls"}}\n```';
        const { name } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(name).toBe('bash');
    });

    test('parses whole-body tool_calls array', () => {
        const text = '{"tool_calls":[{"name":"bash","arguments":{"command":"pwd"}}]}';
        const { name, args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(name).toBe('bash');
        expect(args).toEqual({ command: 'pwd' });
    });

    test('ignores JSON embedded in prose', () => {
        const text = 'Here is an example payload: {"name":"bash","arguments":{"command":"ls"}} — note the shape.';
        expect(parseExternalToolCallsFromText(registry, text)).toEqual([]);
    });

    test('ignores JSON naming an unregistered tool', () => {
        const text = '{"name":"launch_missiles","arguments":{}}';
        expect(parseExternalToolCallsFromText(registry, text)).toEqual([]);
    });

    test('ignores JSON without a name field', () => {
        expect(parseExternalToolCallsFromText(registry, '{"command":"ls"}')).toEqual([]);
    });
});

describe('no false positives on ordinary output', () => {
    test.each([
        ['plain prose', 'B-trees keep all leaves at the same depth.'],
        ['prose naming a tool', 'You can use bash to list files.'],
        ['markdown code block', '```js\nconst name = "bash";\n```'],
        ['angle brackets in math', 'if a < b and b > c then swap'],
        ['empty string', ''],
        ['html-ish prose', 'Use <b>bold</b> for emphasis.']
    ])('%s yields no tool calls', (_label, text) => {
        expect(parseExternalToolCallsFromText(registry, text)).toEqual([]);
    });

    test.each([
        ['plain prose', 'B-trees keep all leaves at the same depth.'],
        ['markdown code block', '```js\nconst name = "bash";\n```'],
        ['html-ish prose', 'Use <b>bold</b> for emphasis.']
    ])('%s survives stripping unchanged', (_label, text) => {
        expect(stripFunctionCallMarkup(text, false, { registry })).toBe(text);
    });

    test('empty registry never yields tool calls', () => {
        const dsml = '<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="bash">\n<｜｜DSML｜｜parameter name="command" string="true">ls</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>';
        expect(parseExternalToolCallsFromText([], dsml)).toEqual([]);
    });
});

describe('streaming: foreign markup is withheld from text deltas', () => {
    const runFilter = (chunks) => {
        const filter = createToolCallFilter({ disableTools: true, registry });
        return chunks.map((chunk) => filter(chunk)).join('') + filter.flush();
    };

    test('suppresses DSML markup split across chunks', () => {
        const chunks = [
            'Let me look.\n',
            '<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="bash">\n',
            '<｜｜DSML｜｜parameter name="command" string="true">ls -la</｜｜DSML｜｜parameter>\n',
            '</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>'
        ];
        expect(runFilter(chunks)).toBe('Let me look.\n');
    });

    test('suppresses canonical markup split mid-tag', () => {
        const chunks = ['keep ', '<function_c', 'alls>{"name":"bash","arguments":{}}</function_calls>', ' tail'];
        expect(runFilter(chunks)).toBe('keep  tail');
    });

    test('suppresses <tool_call> wrapper', () => {
        const chunks = ['pre ', '<tool_call>{"name":"bash",', '"arguments":{"command":"ls"}}</tool_call>'];
        expect(runFilter(chunks)).toBe('pre ');
    });

    test('suppresses whole-body bare JSON', () => {
        expect(runFilter(['{"name":"bash",', '"arguments":{"command":"ls"}}'])).toBe('');
    });

    test('passes ordinary text through unchanged', () => {
        const chunks = ['Hello ', 'world. ', 'a < b > c'];
        expect(runFilter(chunks)).toBe('Hello world. a < b > c');
    });

    test('releases buffered text that turns out not to be markup', () => {
        expect(runFilter(['a < b', ' and c > d'])).toBe('a < b and c > d');
    });

    test('flush releases an unterminated partial tag', () => {
        expect(runFilter(['done <tool_c'])).toBe('done <tool_c');
    });

    // Observed live: the opener lands in one channel and the closer in the other, so a
    // filter can receive a close tag it never saw an opener for. It must not leak.
    // Surrounding whitespace is the model's own text and is preserved.
    test('suppresses an orphaned canonical close tag', () => {
        expect(runFilter(["I'll list the files.\n\n", '</function_calls>'])).toBe("I'll list the files.\n\n");
    });

    test('suppresses an orphaned close tag split across chunks', () => {
        expect(runFilter(['text ', '</function_', 'calls>'])).toBe('text ');
    });

    test.each([
        ['</tool_call>'],
        ['</tool_calls>'],
        ['</invoke>'],
        ['</\uFF5C\uFF5CDSML\uFF5C\uFF5Ctool_calls>']
    ])('suppresses orphaned close tag %s', (tag) => {
        expect(runFilter(['ok ', tag])).toBe('ok ');
    });

    test('keeps ordinary closing html tags', () => {
        expect(runFilter(['see <b>bold</b> here'])).toBe('see <b>bold</b> here');
    });
});

describe('streaming: tool calls are extracted mid-stream', () => {
    const runParser = (chunks) => {
        const parse = createExternalToolCallStreamParser(registry);
        const calls = chunks.flatMap((chunk) => parse(chunk));
        return [...calls, ...parse.flush()];
    };

    test('extracts canonical call split across chunks', () => {
        const calls = runParser(['<function_ca', 'lls>{"name":"bash","argum', 'ents":{"command":"ls"}}</function_calls>']);
        expect(calls).toHaveLength(1);
        expect(calls[0].function.name).toBe('bash');
    });

    test('extracts DSML call split across chunks', () => {
        const calls = runParser([
            '<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invo',
            'ke name="bash">\n<｜｜DSML｜｜parameter name="command" string="true">ls -la',
            '</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>'
        ]);
        expect(calls).toHaveLength(1);
        expect(JSON.parse(calls[0].function.arguments)).toEqual({ command: 'ls -la' });
    });

    test('extracts <tool_call> wrapper call', () => {
        const calls = runParser(['<tool_call>{"name":"read","arguments":{"file":"a.txt"}}</tool_call>']);
        expect(calls).toHaveLength(1);
        expect(calls[0].function.name).toBe('read');
    });

    test('extracts whole-body bare JSON on flush', () => {
        const calls = runParser(['{"name":"bash","arguments":{"command":"ls"}}']);
        expect(calls).toHaveLength(1);
        expect(calls[0].function.name).toBe('bash');
    });

    test('does not emit duplicates for one call', () => {
        const calls = runParser([
            '<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>'
        ]);
        expect(calls).toHaveLength(1);
    });

    test('yields nothing for ordinary prose', () => {
        expect(runParser(['Just ', 'explaining ', 'B-trees.'])).toEqual([]);
    });

    test('assigns distinct ids to repeated calls', () => {
        const calls = runParser([
            '<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>',
            '<tool_call>{"name":"bash","arguments":{"command":"pwd"}}</tool_call>'
        ]);
        expect(calls).toHaveLength(2);
        expect(calls[0].id).not.toBe(calls[1].id);
    });
});

describe('cross-channel blocks', () => {
    // OpenCode streams reasoning and content as separate channels with independent
    // parser buffers. A model that starts a block in one and finishes it in the other
    // leaves neither buffer holding a complete block, so the end-of-stream batch parse
    // has to see the two channels joined.
    test('block split between reasoning and content is found when joined', () => {
        const reasoningPart = 'Thinking about it.\n<function_calls>{"name":"bash",';
        const contentPart = '"arguments":{"command":"ls"}}</function_calls>';

        expect(parseExternalToolCallsFromText(registry, reasoningPart, contentPart)).toEqual([]);

        const joined = parseExternalToolCallsFromText(registry, `${reasoningPart}${contentPart}`);
        expect(joined).toHaveLength(1);
        expect(joined[0].function.name).toBe('bash');
        expect(JSON.parse(joined[0].function.arguments)).toEqual({ command: 'ls' });
    });

    test('joining does not double-count a block wholly inside one channel', () => {
        const content = '<function_calls>{"name":"bash","arguments":{"command":"ls"}}</function_calls>';
        expect(parseExternalToolCallsFromText(registry, `${content}`)).toHaveLength(1);
    });

    test('bare JSON in one channel still parses when that channel is passed alone', () => {
        const calls = parseExternalToolCallsFromText(registry, '{"name":"bash","arguments":{"command":"ls"}}');
        expect(calls).toHaveLength(1);
    });
});

describe('rawCallsFromJsonText JSON scan fallback', () => {
    test('parses nested function_calls wrapper emitted by models echoing the reminder', () => {
        const nested = '<function_calls>\n<function_calls>\n{"name":"external__bash","arguments":{"command":"ls"}}\n</function_calls>';
        const { name, args } = firstCall(parseExternalToolCallsFromText(registry, nested));
        expect(name).toBe('bash');
        expect(args).toEqual({ command: 'ls' });
    });

    test('scan fallback works for JSON prefixed by prose inside the block', () => {
        const text = '<function_calls>calling tool: {"name":"external__bash","arguments":{"command":"pwd"}}</function_calls>';
        const { name, args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(name).toBe('bash');
        expect(args).toEqual({ command: 'pwd' });
    });

    test('clean canonical format still parses correctly after the fallback was added', () => {
        const text = '<function_calls>{"name":"external__bash","arguments":{"command":"echo hi"}}</function_calls>';
        const { name, args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(name).toBe('bash');
        expect(args).toEqual({ command: 'echo hi' });
    });
});

describe('<function=name>/<parameter=key> markup (Qwen/GLM native dialect)', () => {
    test('parses a <tool_call> block with <function=...> and <parameter=...> children', () => {
        const text = '<tool_call>\n<function=bash>\n<parameter=command>ls -la</parameter>\n<parameter=description>list files</parameter>\n</function>\n</tool_call>';
        const { name, args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(name).toBe('bash');
        expect(args).toEqual({ command: 'ls -la', description: 'list files' });
    });

    test('normalizes a separator-dropped tool name to the registry name', () => {
        // `web_fetch`-style mismatch: the model writes the name without the underscore.
        const fetchRegistry = buildExternalToolRegistry([
            { type: 'function', function: { name: 'web_fetch', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } }
        ]);
        const text = '<tool_call>\n<function=webfetch>\n<parameter=url>https://example.com</parameter>\n</function>\n</tool_call>';
        const calls = parseExternalToolCallsFromText(fetchRegistry, text);
        expect(calls).toHaveLength(1);
        expect(calls[0].function.name).toBe('web_fetch');
        expect(JSON.parse(calls[0].function.arguments)).toEqual({ url: 'https://example.com' });
    });

    test('strips the <function=...> block from visible text', () => {
        const text = 'Let me run a command.\n<tool_call>\n<function=bash>\n<parameter=command>ls</parameter>\n</function>\n</tool_call>';
        const stripped = stripFunctionCallMarkup(text);
        expect(stripped).not.toContain('<function=');
        expect(stripped).not.toContain('<parameter=');
        expect(stripped).not.toContain('</function>');
        expect(stripped).toContain('Let me run a command');
    });
});
