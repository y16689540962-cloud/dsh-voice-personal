# Third-party notices / 第三方内容与许可证

This package ships exactly one piece of third-party content. Everything else in the tarball
is original and dependency-free (`dependencies` is empty).

本包只分发一样第三方内容，其余全部原创且零依赖。

---

## 拼音表 `dist/data/pinyin-table.txt` — MIT

| 项 | 值 |
| --- | --- |
| 上游 | [mozillazg/pinyin-data](https://github.com/mozillazg/pinyin-data) |
| 许可证 | MIT |
| 版权 | Copyright (c) 2016 mozillazg |
| 我们的改动 | 抽取 26,711 个汉字的普通话读音；去声调；`ü` 写作 `v`；压成 `字拼音字拼音…` 连排格式。**读音本身未改动** |
| 上游的再上游 | 读音来自 [Unihan 数据库](https://www.unicode.org/reports/tr38/) 的 `kMandarin`、`kHanyuPinyin`、`kTGHZ2013`、`kXHC1983` 等字段 |

MIT requires the copyright and permission notice to be retained in all copies or substantial
portions, so here it is in full:

```
The MIT License (MIT)

Copyright (c) 2016 mozillazg

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
```

---

## Not included / 明确没有包含

- **No model.** The speaker-verification model (`campplus.onnx`, Apache-2.0, from
  [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)) belongs to the DSH plugin and is
  distributed as a GitHub Release asset, not here. See the repository's
  `THIRD-PARTY-NOTICES.md`.
- **No simplified/traditional conversion data.** `opencc-js` was considered and deliberately
  not used.
- **No pypinyin code or data.** pypinyin was used only to *audit* the readings of the shipped
  table; nothing was copied from it.
- **No third-party source code at all.**
