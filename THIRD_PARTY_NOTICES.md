# Third-party notices

router-worker is based on **dsh-superagent** by the DeepSeek Harness Team,
https://github.com/deepseek-ai/dsh-superagent-prototype, used under the MIT License below.

What router-worker takes from it:

- the design principle quoted in `docs/00-principles.md` ("take as little human attention as possible,
  and give as much value as possible") and the domain concepts mapped in `docs/06-lineage.md`;
- the `rw-worker` agent preset in `plugin/dsh/cordis.patch.yml`, adapted from dsh-superagent's
  `dsh-superagent-worker` preset;
- the DeepSeek Harness API surface that `plugin/dsh/index.ts` declares, as dsh-superagent uses it.

The code, prompts and skills of router-worker are its own and carry its own license (`LICENSE`).

---

MIT License

Copyright (c) 2026 DeepSeek Harness Team

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
