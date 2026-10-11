;; Probe module for the E2E suite: per-instance state, exported (non-shared)
;; memory, a never-ending call, a trap, and a slow call with a result.
(module
  (memory (export "memory") 2)
  (global $count (mut i32) (i32.const 0))
  (global (export "MAGIC") i32 (i32.const 42))

  ;; Returns how many times it was called on this instance.
  (func (export "inc") (result i32)
    global.get $count
    i32.const 1
    i32.add
    global.set $count
    global.get $count)

  (func (export "add") (param i32 i32) (result i32)
    local.get 0
    local.get 1
    i32.add)

  (func (export "load8") (param i32) (result i32)
    local.get 0
    i32.load8_u)

  (func (export "store8") (param i32 i32)
    local.get 0
    local.get 1
    i32.store8)

  (func (export "spin")
    (loop $forever
      br $forever))

  (func (export "trap")
    unreachable)

  ;; Busy-loops `n` times, then returns `tag`.
  (func (export "burn") (param $n i32) (param $tag i32) (result i32)
    (local $i i32)
    (block $done
      (loop $next
        local.get $i
        local.get $n
        i32.ge_u
        br_if $done
        local.get $i
        i32.const 1
        i32.add
        local.set $i
        br $next))
    local.get $tag)
)
