# Set a DeepSeek API key

A Bot whose model is on the DeepSeek API route (`deepseek-official`, for example **DeepSeek-V41-Flash**) needs a DeepSeek API key. Without one, its turn fails with **This Bot's model has no API key yet** (`MISSING_CREDENTIAL`).

FlyBot does not keep the key. DeepSeek Harness (DSH) stores it and sends it with each model request, under the name `DEEPSEEK_API_KEY`. Get a key on the [DeepSeek platform](https://platform.deepseek.com/api_keys). On DSH Desktop, **Sign in to DeepSeek** is another way: it uses your DeepSeek account and needs no key.

There are three ways to set the key. Pick one.

## 1. In the app

1. Under the error, click **Enter a DeepSeek API key** (a Bot with no model offers the same button). You can also open Settings → **Models** and set up DeepSeek there.
2. **Type or paste** the key into the **API key** field.
3. Click **Save and continue**, then send your message again.

The dialog belongs to DSH. It keeps only what you type or paste: a value that a script, an accessibility tool or some password managers put into the field can be cleared when you click **Save and continue**, and nothing is saved ([#451](https://github.com/ThinkFlowLab/FlyBot/issues/451)). In that case paste the key by hand, or use way 2 or 3.

## 2. In the credentials file

The dialog saves the key to a file in your DSH home folder. You can write that file yourself, for example on a server or before the first start:

- `~/.dsh/.credentials.yaml`, or `.credentials.yaml` in `DSH_HOME` when it is set
- Windows: `C:\Users\<user>\.dsh\.credentials.yaml`

```yaml
version: 1
refs:
  DEEPSEEK_API_KEY: sk-your-key
```

If the file already exists, add the `DEEPSEEK_API_KEY` line under `refs` and keep the other entries. Only you may read the file: on Linux and macOS run `chmod 600 ~/.dsh/.credentials.yaml`, because DSH refuses to load a file that other users can read. DSH also refuses a file with anything else at the top level. A running DSH picks up the change by itself; no restart is needed.

## 3. In the environment

Set `DEEPSEEK_API_KEY` in the shell that starts DSH:

```sh
DEEPSEEK_API_KEY=sk-your-key npx -y @deepseek-ai/dsh@0.2.0-rc.2 web --port 3080
```

DSH reads the environment once, at start, so a key exported later needs a restart. While it is set, it wins over every other place and DSH treats the key as read-only: saving a different key in the app is refused until you start DSH without the variable.

A `.env` file with a `DEEPSEEK_API_KEY=sk-your-key` line also works, either in the folder you start DSH from or in your DSH home folder (`~/.dsh/.env`). A key saved in the app or in the credentials file wins over both.

## Which key DSH uses

The first place that has a key wins:

| Place | Set by |
| --- | --- |
| The environment DSH was started in | `DEEPSEEK_API_KEY=… dsh …` |
| The credentials file | the app (way 1) or you (way 2) |
| `.env` in the folder you start DSH from | you |
| `.env` in your DSH home folder | you |

## Keep the key safe

- Never send the key to a Bot in a chat, and never commit a `.env` or `.credentials.yaml` file.
- Bots run as your own OS user, so a Bot that runs commands could read the credentials file. Use a key that you can revoke on the DeepSeek platform.
