// Keep package.json#version, jsr.json#version, and any in-source
// version constants in lock-step. The default Bumpp behavior only
// touches package.json and other package.json files in a workspace.

export default {
  files: ["package.json", "jsr.json"],
}
