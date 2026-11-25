# Guides

Recipes for the things most apps do with electron-cast after the [first cast works](../GETTING-STARTED.md).

| Guide | Use it when |
|---|---|
| [Building your own device picker](device-picker.md) | You want a window instead of a menu, with devices that appear while it is open |
| [Rejoining a session after a restart](restart-rejoin.md) | The app quits while casting and the user expects the cast to still be theirs when it comes back |
| [Multiple windows and iframes](windows-and-iframes.md) | More than one window or view casts, or an embedded player in an iframe does |
| [Custom receivers and the Default Media Receiver](custom-receivers.md) | You choose which receiver app plays, or talk to your own receiver |
| [Audio-only devices and speaker groups](audio-and-groups.md) | Your picker has to tell a TV, a speaker and a group apart |
| [Device authentication](device-authentication.md) | A device is refused, or you need to cast to a receiver that is not Google-certified |
| [Using CastClient directly](low-level-client.md) | You want discovery, the Cast v2 channel or the protocol code without Electron |
| [Testing your app](testing.md) | You want tests that need neither a Cast device nor a network |

Each guide checks its TypeScript against the package's own types (`npm run docs:check`), so the snippets compile as
written unless marked as fragments. What a guide says was tested, was tested; where it says otherwise, it was not.
