;; Imports a function nobody provides: instantiation must fail with a LinkError.
(module
  (import "env" "missing" (func))
  (func (export "ok") (result i32) i32.const 1))
