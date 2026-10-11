// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) DUSK NETWORK. All rights reserved.

// Module entry of the sandbox worker, loaded as a same-origin file so bundlers
// emit it and pages limited to `worker-src 'self'` can start it.
import worker from "./worker.js";

worker();
