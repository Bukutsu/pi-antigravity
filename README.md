# pi-antigravity

This is my own slop fork of [Rahularya01/pi-antigravity](https://github.com/Rahularya01/pi-antigravity). I add features here that might get merged upstream, so expect rough edges.

It's a [Pi](https://pi.dev) provider for Google Antigravity / Cloud Code Assist models (Gemini, plus the Claude and GPT-OSS models Antigravity advertises). Sign in with Google, pick a model, go.

What this fork adds:

- `read_url_content` tool and `/antigravity.fetch` ([PR #102](https://github.com/Rahularya01/pi-antigravity/pull/102))
- `ANTIGRAVITY_DEFER_TOOLS` to hide the extra tools from the model ([PR #105](https://github.com/Rahularya01/pi-antigravity/pull/105))

> Unofficial. Not affiliated with or endorsed by Google. Only use it with an account you're allowed to use.

## Install

Needs Node 22.19+ and Pi 0.80+.

```bash
pi install git:github.com/Bukutsu/pi-antigravity
```

Then restart Pi or run `/reload`.

## Use

1. Run `/login antigravity` and finish Google sign-in.
2. Pick a model, for example `/model antigravity/gemini-3.8-flash`.
3. If something fails, run `/antigravity.doctor`.

Your tokens are stored in `~/.pi/agent/auth.json` and `~/.pi/agent/antigravity-accounts.json`. Don't commit or share them.

## Commands

| Command                            | What it does                                                 |
| ---------------------------------- | ------------------------------------------------------------ |
| `/login antigravity`               | Sign in. Run it again to link another account.               |
| `/antigravity.accounts`            | List accounts. `switch` or `remove` takes an index or email. |
| `/antigravity.models`              | List models and quota.                                       |
| `/antigravity.usage`               | Show quota and reset times.                                  |
| `/antigravity.refresh`             | Refresh the model list.                                      |
| `/antigravity.doctor`              | Safe diagnostics.                                            |
| `/antigravity.search <query>`      | Google search.                                               |
| `/antigravity.fetch [--raw] <url>` | Read a web page as markdown.                                 |
| `/antigravity.image <prompt>`      | Make an image, saved in `.pi/generated-images/`.             |

## Tools for the model

- `google_search`: web search with sources.
- `generate_image`: makes an image in the project folder.
- `read_url_content`: reads a public page as markdown.

### read_url_content

Google fetches the page, not your machine, so you get Google's copy. It can be old or cut off, and it can't log in or run scripts.

- If the copy looks broken, it retries live, then tries one alternate copy from the same site.
- The result says if the page looks complete, blocked, or cut short.
- Long pages show the start and save the whole page to a private temp file. The answer ends with the path.
- `--raw` returns the page exactly as Google sent it.
- It refuses local or private addresses, URLs with a password, and PDFs.

Limits are listed in [docs/reader-guarantees.md](docs/reader-guarantees.md).

## Settings

Environment variables:

| Variable                          | What it does                                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `ANTIGRAVITY_NO_EXTRA_TOOLS=1`    | Turn off all three tools.                                                                           |
| `ANTIGRAVITY_NO_SEARCH_TOOL=1`    | Turn off `google_search`.                                                                           |
| `ANTIGRAVITY_NO_FETCH_TOOL=1`     | Turn off `read_url_content`.                                                                        |
| `ANTIGRAVITY_NO_IMAGE_TOOL=1`     | Turn off `generate_image`.                                                                          |
| `ANTIGRAVITY_DEFER_TOOLS=1`       | Don't show the tools to the model. Codemode and `tool_search` can still use them. Needs Pi 0.99.2+. |
| `ANTIGRAVITY_WEB_FETCH_MAX_CHARS` | Max size of one page result. Default 60000.                                                         |
| `ANTIGRAVITY_PROJECT_ID`          | Use a specific project instead of discovering one.                                                  |
| `ANTIGRAVITY_BASE_URL`            | Use another API host. Must be an HTTPS Google APIs host.                                            |

The old `NOAGY_` prefix also works. Run `/reload` after changing them.

## Problems

- **401 / 403:** run `/login antigravity` again.
- **"Verify your account":** open the link from the error in a browser signed in to that account.
- **Can't sign in on a remote machine:** finish sign-in in any browser, then paste the failed `localhost:51121` URL into Pi. Or tunnel the port: `ssh -N -L 51121:127.0.0.1:51121 <user>@<server>`.
- **Model missing or quota hit:** run `/antigravity.models` or `/antigravity.usage`.

## Development

```bash
corepack enable
yarn install --immutable
yarn check
```

`yarn smoke:fetch` is an optional live test of the page reader. It needs `/login antigravity` first.

## License

[MIT](LICENSE)
