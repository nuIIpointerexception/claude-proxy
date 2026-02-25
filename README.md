# claude-intercept

intercepts claude requests and all sse and json data so you can view what the heck they are doing.
for eductional and security purposes only...

# quick guide

1. `bun install`
2. `bun run start`
3. `bun run pretty`
4. set claude code `anthropic_base_url` to `http://127.0.0.1:8787` or run `bun run setup` for auto install (only linux tested)
5. profit

vibe coded with ai, just needed this quick for some research.

can output to both axiom.co and locally archive..

tip: you can prettify the output with `bun run pretty` to prettify the archives output in-place.
