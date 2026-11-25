// This import is used only by the upstream CI test runner, never the built image.
import { register } from 'node:module';
register('./upstream-test-clock-loader.mjs', import.meta.url);
