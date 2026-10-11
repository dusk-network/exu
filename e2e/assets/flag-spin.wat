;; Uses the shared memory the custom imports provide: sets byte 0 so the host
;; can see the call is running, then never returns.
(module
  (import "env" "memory" (memory 1 100 shared))
  (func (export "flag_then_spin")
    i32.const 0
    i32.const 1
    i32.atomic.store8
    (loop $forever
      br $forever)))
