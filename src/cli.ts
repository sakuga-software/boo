#!/usr/bin/env node
// Set NODE_ENV before React loads. The development build of React records a performance entry
// at each render, and Node keeps these entries. A watch of some hours then fills the heap.
process.env.NODE_ENV = "production";
await import("./main.js");
