# Third-party notices

The simulator's own source is MIT — see [`LICENSE`](LICENSE). It depends on, and
its build output redistributes, the following.

## p5.js

- **Package:** [`p5`](https://www.npmjs.com/package/p5) 1.11.x
- **Home:** https://p5js.org · https://github.com/processing/p5.js
- **Licence:** GNU Lesser General Public License, version 2.1
- **Full text:** shipped with the package at `node_modules/p5/license.txt`, and
  published at https://github.com/processing/p5.js/blob/main/license.txt

p5.js is used for canvas rendering and pointer input. It is a dependency, not a
vendored copy: nothing in this repository is derived from or modifies p5's
source.

### Why the build keeps p5 in its own file

`npm run build` emits p5 as a separate chunk (`dist/assets/p5-*.js`) rather than
inlining it into the application bundle, and emits source maps alongside both.

That started as a caching decision — p5 is ~1 MB and never changes between
deploys, while the simulator itself is ~14 kB — but it is also what LGPL-2.1 §6
asks for from a work that uses the library. Anyone receiving the deployed page
can replace that one file with their own build of p5 and reload, without needing
anything from this project.

Both chunks are minified, and a full source map is emitted next to each
(`p5-*.js.map`, `index-*.js.map`) and deployed with them, so the library as
shipped can be read and traced back to p5's own sources.

No p5 source is modified, and the simulator only calls p5's public API.

## Everything else

There are no third-party images, fonts, sounds, or datasets in this repository.
Every asset under [`screenshots/`](screenshots/) is generated from this project
by `npm run screenshots`.
