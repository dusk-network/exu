// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) DUSK NETWORK. All rights reserved.

//! The foreign function interface for the wallet.

// #![deny(missing_docs)]
#![deny(clippy::all)]
#![no_std]
extern crate alloc;

use alloc::vec::Vec;

use core::mem;

extern crate wee_alloc;

// Use `wee_alloc` as the global allocator.
#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

#[no_mangle]
pub static mut BUFFER: [u8; 64 * 1024] = [0; 64 * 1024];

#[repr(transparent)]
pub struct FatPtr(u64);

impl FatPtr {
    const fn size(&self) -> u32 {
        (self.0 & 0xffff_ffff) as u32
    }

    const fn ptr(&self) -> u32 {
        (self.0 >> 32) as u32
    }
}

impl<T> From<&[T]> for FatPtr {
    fn from(value: &[T]) -> Self {
        let ptr = &value[0] as *const T;
        let size = value.len();

        Self(((ptr as u64) << 32) | size as u64)
    }
}

/// Signal to the host a string message
fn signal(msg: &str) {
    let bytes = msg.as_bytes();
    unsafe { sig(bytes.into()) }
}

extern "C" {
    fn sig(ptr: FatPtr);
}

/// Allocates memory with a given size.
#[no_mangle]
pub unsafe extern "C" fn malloc(cap: u32) -> *mut u8 {
    let mut buf = Vec::with_capacity(cap as usize);
    let ptr = buf.as_mut_ptr();
    mem::forget(buf);
    ptr
}

/// Free memory pointed to by the given `ptr`, and the given `cap`acity.
#[no_mangle]
pub unsafe extern "C" fn free(ptr: *mut u8, cap: u32) {
    Vec::from_raw_parts(ptr, 0, cap as usize);
}

/// Read 1 byte at the address given
#[no_mangle]
pub unsafe extern "C" fn byte(ptr: *mut u8) -> u8 {
    *ptr
}

/// Write 1 byte at the address given
#[no_mangle]
pub unsafe extern "C" fn set_byte(ptr: *mut u8, value: u8) {
    *ptr = value;
}

/// Simple fibonacci function
#[no_mangle]
pub unsafe extern "C" fn fibonacci(n: u32) -> u32 {
    match n {
        0 => 1,
        1 => 1,
        _ => fibonacci(n - 1) + fibonacci(n - 2),
    }
}

/// Endless loop function call
#[no_mangle]
pub unsafe extern "C" fn endless_loop() {
    loop {}
}

#[no_mangle]
pub unsafe extern "C" fn to_lower_case() {
    let mut i = 0;

    // Loop through BUFFER until we hit the null terminator
    while i < BUFFER.len() && BUFFER[i] != 0 {
        // If the character is an uppercase letter (A-Z), convert to lowercase
        if BUFFER[i] >= b'A' && BUFFER[i] <= b'Z' {
            BUFFER[i] = BUFFER[i] + (b'a' - b'A');
        }
        i += 1;
    }
}

#[cfg(target_family = "wasm")]
mod panic_handling {
    use super::*;

    use core::fmt::{self, Write};
    use core::panic::PanicInfo;

    impl Write for PanicMsg {
        fn write_str(&mut self, s: &str) -> fmt::Result {
            let bytes = s.as_bytes();
            let len = bytes.len();
            self.buf[self.ofs..self.ofs + len].copy_from_slice(bytes);
            self.ofs += len;
            Ok(())
        }
    }

    struct PanicMsg {
        ofs: usize,
        buf: [u8; 1024],
    }

    impl AsRef<str> for PanicMsg {
        fn as_ref(&self) -> &str {
            core::str::from_utf8(&self.buf[0..self.ofs]).unwrap_or("PanicMsg.as_ref failed.")
        }
    }

    #[panic_handler]
    fn panic(info: &PanicInfo) -> ! {
        let mut msg = PanicMsg {
            ofs: 0,
            buf: [0u8; 1024],
        };

        writeln!(msg, "{}", info).ok();

        signal(msg.as_ref());

        loop {}
    }
}
