import { main } from './project-role-github-cli.mjs'
// Git adds get/store/erase. Only get can return an in-memory credential.
if (process.argv.at(-1) === 'get') await main(process.argv[2], 'credential-helper', [])
