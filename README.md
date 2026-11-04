# sv

Everything you need to build a Svelte project, powered by [`sv`](https://github.com/sveltejs/cli).

## Creating a project

If you're seeing this, you've probably already done this step. Congrats!

```sh
# create a new project
npx sv create my-app
```

To recreate this project with the same configuration:

```sh
# recreate this project
npx sv@0.16.6 create --template minimal --types ts --install npm /tmp/claude-1000/-home-hemang-Desktop-ESS/2c0c2cc0-0dd5-4d53-afea-4e6183210ee0/scratchpad/sk-scaffold
```

## Developing

Once you've created a project and installed dependencies with `npm install` (or `pnpm install` or `yarn`), start a development server:

```sh
npm run dev

# or start the server and open the app in a new browser tab
npm run dev -- --open
```

## Building

To create a production version of your app:

```sh
npm run build
```

You can preview the production build with `npm run preview`.

> To deploy your app, you may need to install an [adapter](https://svelte.dev/docs/kit/adapters) for your target environment.

## Deploying to Cloudflare

The same Docker image runs on Cloudflare Containers, with Postgres, MongoDB and
Redis kept as separate databases. The wrapper lives in `cloudflare/`; the
step-by-step guide is [docs/cloudflare-deployment.md](docs/cloudflare-deployment.md).
