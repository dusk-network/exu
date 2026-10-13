// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) DUSK NETWORK. All rights reserved.

import process from "node:process";

/**
 * Where Exu finds the class it starts sandbox workers with on Node, so tests
 * can stand in for it (`threads.Worker = ...`).
 */
export const threads = process.getBuiltinModule("node:worker_threads");
