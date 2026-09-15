# ComfyFed

[繁體中文版 →](README.md)

### What it is

ComfyFed connects a group of friends' graphics cards into one small rendering federation: whoever's GPU is free helps run whoever's job just got submitted. You don't need a beastly GPU of your own, and you don't need to know how to install ComfyUI or wire up nodes — open a browser, pick a template, edit a couple of words, and the federation's machines take it from there. The image or video shows up right in the web console when it's done, ready to view or download.

The whole circle runs on **invitation**: only people you trust get in, and both the person who submits a job and the person who lent the GPU can see who did what. It's not a public service anyone can connect to.

### What you can do with it

Open the built-in workflow editor and there are 10 ready-made templates in the sidebar. Every one has a red sticky note on the canvas marking exactly what to edit — you can produce something real without ever writing code or touching ComfyUI directly:

- **Wuxia text-to-image** — describe a scene in words, get a wuxia-styled image
- **Character portrait** — the same pipeline in portrait orientation, for a single character's reference sheet
- **Reference to video** — feed in one photo and watch that person move, with generated audio
- **First+last frame to video** — give a first frame and a last frame; the motion in between is filled in automatically
- **Video concat** — stitch two clips into one, picture and audio both
- **Image intro + video** — hold a still image as a title card, then play a clip
- **Video trim** — cut the segment you want out of a longer clip
- **Image upscale** — turn a small image into a high-resolution one
- **Image to prompt** — upload a reference image, get a polished English prompt written for you
- **Text to prompt** — paste a rough idea, get it rewritten into a structured English prompt

Opening a template clones it onto your own canvas — the template itself never gets damaged. Edit it, hit **Run**, and the job goes straight into the federation's queue; the result and its record both show up on the console's Jobs page once a worker finishes it.

### Two ways to set it up

**A. Your own computer or VM**: a good fit if you (or your household/office) already have a machine that stays on — nothing fancy, Windows or Linux both work. Install the server once, expose one address people can reach (home DDNS or a fixed IP both work), and friends' GPUs can connect in. Details and commands are in the [self-hosting guide](docs/SELF-HOSTING.en.md).

**B. Cloudflare Cloud edition**: don't want to babysit a machine that's on 24/7, deal with DDNS, or open any ports — connect the project to your own Cloudflare account (its free tier is enough) and deploying gives you a URL to use. Details in the [cloud guide](cloud/README.md); the first setup step is roughly:

```bash
cd cloud && npm install && npx wrangler login
```

Both routes run the **same federation protocol and the same agent** underneath — only where the server lives differs. Connecting a friend's GPU is the identical step either way.

### Contributing GPU time

If you have a spare GPU you'd like to lend the group, install a small program called `comfyfed-agent` on that machine; once it registers with the platform, it starts picking up jobs and rendering. Your machine only ever makes **outbound** connections to find the platform — no port needs to be opened, and it works fine sitting behind a home NAT. To stop it, press `Ctrl-C` in its window; it finishes cleaning up whatever it was doing before it actually exits, so nothing is left half-done.

Every finished job produces a receipt **signed by both sides** — you (the worker) and the platform — recording exactly how much compute you contributed. Since neither side can fake a signature the other didn't make, that record is trustworthy on its own, and the Reports page turns it into a leaderboard.

Members can also hand model files to each other directly, so nobody has to re-download the same thing from the outside world — a new machine joining in gets missing models faster and with less bandwidth, as long as someone in the circle is online and already has them.

When a job needs a model a worker doesn't have, the worker fills the gap itself: models the platform vouches for are downloaded automatically, up to 20 GB per job by default (`max_fetch_gb`). Larger model sets are a manual step — raise the budget or copy the files in yourself. Set `auto_fetch_models` to `false` to turn auto-fetch off entirely.

### Safety and trust

ComfyFed is designed for people who know each other, not the open internet:

- **One-line join**: copy the install command the admin gives you and run it on that machine to turn it into a compute member — missing Python or ComfyUI gets installed automatically, and it's set to start on login
- **Idle-detection auto-pause**: it notices when you're actively using the machine and stops taking new jobs (anything already running finishes normally), then resumes once you step away — or control it by hand from the command line with `comfyfed pause`/`resume`
- **Invite-only**: joining requires a one-time registration link the admin issued, which stops working the moment it's used
- **Node whitelist**: a worker can restrict which kinds of ComfyUI nodes it's willing to run, so a workflow someone else submits can't do arbitrary things on your machine
- **Dual-signed receipts**: contribution records are signed by both sides — auditable, and neither side can forge them alone
- **Signed end-to-end**: every connection and every API call is cryptographically verified, never sent in the clear
- **Individual accounts**: an admin can set up a login for each person in the circle — everyone sees only the jobs and pieces they submitted, while the admin gets the full overview and billing picture

### Documentation

- Self-hosting guide: [繁體中文](docs/SELF-HOSTING.zh.md) | [English](docs/SELF-HOSTING.en.md)
- Cloudflare Cloud edition guide: [cloud/README.md](cloud/README.md)
- Model downloads the templates need: see "Model downloads" in the self-hosting guide ([繁體中文](docs/SELF-HOSTING.zh.md) | [English](docs/SELF-HOSTING.en.md))

### License

License: [AGPL-3.0](LICENSE).
