<p align="center">
  <a href="https://programming-game.com">
    <img src="https://programming-game.com/og" width="70%">
  </a>
</p>
<p align="center">
  <a href="https://programming-game.com">Programming Game</a> is an mmorpg that you play entirely through code.
</p>

## Quick Demo

If you haven't signed up for an account, there's an in-browser, no sign up demo available [here](https://programming-game.com/demo).

## Setup

```bash
git clone git@github.com:gdborton/programming-game-starter.git
cd programming-game-starter
touch .env
# Update your .env with USER_ID and API_KEY
# You can find these values here:
# https://programming-game.com/dashboard
npm install
npm start
# Open local dashboard: http://localhost:8787
```

## Playing the Game

Watch your character react as you change code at `https://programming-game.com/watch/<character>`, there are quicklinks for each of your characters in your [dashboard](https://programming-game.com/dashboard).

There's a basic [getting started guide](https://programming-game.com/docs/getting-started) that walks you through the most basic mechanics of the game. It's **highly** recommended that you work through this.

## Staying Connected

The game is designed to be played 24/7. It can be advantageous to deploy the game to a SAAS that allows you to run 24/7.

Some low cost providers:

- [fly.io](https://fly.io) - You can run a client on fly.io for less than $5/month.
- [heroku](https://heroku.com) - you can deploy a single dyno that stays connected for $5/month.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `USER_ID` | *(required)* | Your game user ID — found at https://programming-game.com/dashboard |
| `API_KEY` | *(required)* | Your game API key — found at https://programming-game.com/dashboard |
| `DASHBOARD_PORT` | `8787` | Port for the local bot dashboard (`http://localhost:<port>`) |
| `LOW_HP_THRESHOLD_PERCENT` | `25` | HP % at or below which the bot retreats home to heal (clamped 1–95) |
| `LOG_DIR` | current working directory | Directory where `overworld.log`, `arena.log`, and `deaths/` snapshots are written |

## Getting Help

If you need any help with code or mechanics, or want to coordinate with other players, come [join the discord server](https://discord.gg/69M8p25ffP)
