[![gpt-advisor demo: the GPT advisor is turned on in /config, then Claude consults Fable 5.2 and GPT 6 Astra](demo/gpt-advisor-demo.gif)](demo/gpt-advisor-demo.mp4)

[Watch the demo with sound (MP4)](demo/gpt-advisor-demo.mp4)

# gpt-advisor

gpt-advisor is a plugin for Claude Code. The plugin gives Claude a `gpt_advisor` tool, the GPT advisor. The GPT advisor operates like the native advisor, but an OpenAI GPT model gives the advice. The plugin sends each request to the GPT model through the Codex CLI.

## How it works

- Claude calls the `gpt_advisor` tool with no parameters.
- The plugin sends the full transcript to the GPT model. The transcript contains the system prompt, the tool list, the messages, the tool calls and the tool results.
- The GPT model has no tools. It reads the transcript and returns advice as text.
- The plugin adds guidance to the system prompt. The guidance tells Claude when to call the GPT advisor.
- The tool row shows `Advising using <model>`, as the native advisor row does. Press ctrl+o to read the advice.
- If a call fails, the tool result tells Claude the cause. The turn continues.

## Requirements

- You must have Claude Code with the plugin system and plugin settings in `/config`.
- You must install the Codex CLI (`codex`) and log in. Your OpenAI account must have access to the model that you select.
- You must have the GNU `timeout` command. Linux has this command. On macOS, install GNU coreutils with Homebrew. Then add its `gnubin` folder to `PATH`, so that the command name `timeout` works:

  ```
  brew install coreutils
  export PATH="$(brew --prefix)/opt/coreutils/libexec/gnubin:$PATH"
  ```

  To keep this change, add the `export` line to your shell profile (for example, `~/.zshrc`).

## Setup

> **CAUTION:** The plugin sends the full transcript to OpenAI. The transcript includes the system prompt and the contents of the files that Claude read. The plugin masks secrets by pattern only, so some secrets can stay in the text.

1. Install the Codex CLI:

   ```
   npm install -g @openai/codex
   ```

2. Make sure that the Codex CLI is installed:

   ```
   codex --version
   ```

   The command shows the version number.

3. Log in to the Codex CLI with your OpenAI account:

   ```
   codex login
   ```

4. Install the plugin with one of these commands:

   - In Claude Code:

     ```
     /plugin install gpt-advisor --marketplace souf92i/gpt-advisor
     ```

   - In a shell:

     ```
     claude plugin install gpt-advisor --marketplace souf92i/gpt-advisor
     ```

5. Start a new Claude Code session, or run `/reload-plugins` in the current session.
6. Open `/config`.
7. Type `gpt` in the search field. The list shows the plugin settings.
8. Set **GPT advisor** to `true`.
9. Set **GPT advisor mode** to `alongside` or `replace`.
10. Set **GPT advisor model** to a model that your OpenAI account can use.
11. Close `/config`.

## Check the installation

1. Run `/gpt-advisor` in Claude Code.
2. Read the output:

   ```
   Enabled: true (turn on or off in /config)
   Mode: alongside (choices: alongside, replace)
   Model: gpt-6-astra (choices: gpt-6-astra, gpt-6.1-terra, gpt-6.1-sol)
   ```

3. Make sure that the output shows `Enabled: true`, and the mode and the model that you set.

To do a full test (optional):

1. Give Claude a small coding task.
2. Look for the row "Advising using GPT 6 Astra". The row shows the name of the model that you set.
3. Press ctrl+o to read the advice.

## Settings

The plugin adds three settings to `/config`. A change takes effect from the next turn of the current conversation.

| Setting | Values | Default | Function |
|-|-|-|-|
| GPT advisor | `true`, `false` | `false` | Gives the `gpt_advisor` tool to Claude, or removes it. |
| GPT advisor mode | `alongside`, `replace` | `alongside` | `alongside`: Claude can use the native advisor and the GPT advisor. If the native advisor is on, Claude calls it first, then the GPT advisor. `replace`: the GPT advisor is the only advisor. The plugin shows a warning while the native advisor is on. |
| GPT advisor model | `gpt-6-astra`, `gpt-6.1-terra`, `gpt-6.1-sol` | `gpt-6-astra` | The GPT model that gives the advice. The reasoning effort is always `max`. |

You can also read and change the settings with the `/gpt-advisor` command:

| Command | Function |
|-|-|
| `/gpt-advisor` | Shows the current settings. |
| `/gpt-advisor model <name>` | Sets the GPT model. |
| `/gpt-advisor mode <mode>` | Sets the mode: `alongside` or `replace`. |

## Differences from the native advisor

- The tool name is `gpt_advisor`, not `advisor`.
- One call takes minutes, not seconds. The plugin stops a call after 20 minutes.
- The transcript limit is about 600,000 characters. If the transcript is longer, the plugin removes the oldest messages after the first message. A marker gives the number of removed messages.
- The plugin masks secrets before it sends the transcript. It finds secrets by pattern only (API keys, tokens, private keys and JWTs). Some secrets can stay in the text.
- The plugin does not send thinking blocks, images or documents.
- The Codex CLI runs in read-only mode. Its shell and its other tools are off.
- Code Mode is off in every session while the plugin is installed. This is also true when the GPT advisor is off. Claude Code does not support Code Mode with a plugin that handles tool calls.

## Troubleshooting

All errors from a call start with `GPT advisor unavailable:`. If the error contains text in parentheses, this text is the last line of the error output. Read this text to find the cause.

| Symptom | Cause | Action |
|-|-|-|
| `GPT advisor unavailable: codex exited with code 127 and no advice` | The `codex` command is not in `PATH`. | Install the Codex CLI (see "Setup"). Make sure that `codex --version` works in the shell that starts Claude Code. |
| `GPT advisor unavailable: codex exited with code ...` | The Codex CLI is not logged in. | Run `codex login`. |
| `GPT advisor unavailable: codex exited with code ...` | Your OpenAI account does not have access to the selected model. | Select a different model in `/config`, or run `/gpt-advisor model <name>`. |
| `GPT advisor unavailable: timed out after 20 minutes` | The call took more than 20 minutes. The plugin stopped the Codex CLI. | Ask Claude to call the GPT advisor again, or continue without the advice. |
| The row shows `The native advisor gave no result. Claude calls it again.` | In `alongside` mode, Claude called the native advisor and the GPT advisor together. A native advisor call that Claude makes together with a different tool call gets no result. | The plugin does not call the Codex CLI. It tells Claude to call the native advisor again, then the GPT advisor. If Claude does not do this, ask Claude to call the two advisors again. |
| `gpt-advisor is in replace mode, but the native advisor is on. Turn it off with /advisor.` | The mode is `replace`, and the native advisor is on. | Turn off the native advisor with `/advisor`, or set the mode to `alongside`. |
| The "Advising using" row never shows. | The GPT advisor is off, or Claude did not call it. In `replace` mode, Claude can prefer the native advisor while the native advisor is on. | Run `/gpt-advisor` and make sure that it shows `Enabled: true`. In `replace` mode, turn off the native advisor with `/advisor`. |

## Uninstall

1. Remove the plugin:

   ```
   claude plugin uninstall gpt-advisor
   ```

2. Remove the marketplace:

   ```
   claude plugin marketplace remove gpt-advisor
   ```

## License

This plugin uses the MIT license. See [LICENSE](LICENSE).
