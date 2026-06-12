/**
 * app/feedback.ts — F-28
 *
 * Floating feedback button and modal logic.
 * Exports initFeedback() which wires all DOM event listeners.
 */

import { track } from "./analytics";

/**
 * initFeedback(): void
 *
 * Reads the six required DOM elements. If any are missing, returns early.
 * Wires click handlers for open, close (cancel, overlay background click),
 * and submit (POST to /api/feedback).
 */
export function initFeedback(): void {
  const btn = document.getElementById("feedback-btn");
  const overlay = document.getElementById("feedback-overlay");
  const cancelBtn = document.getElementById("feedback-cancel");
  const submitBtn = document.getElementById("feedback-submit") as HTMLButtonElement | null;
  const textArea = document.getElementById("feedback-text") as HTMLTextAreaElement | null;
  const confirmEl = document.getElementById("feedback-confirm");

  if (
    btn === null ||
    overlay === null ||
    cancelBtn === null ||
    submitBtn === null ||
    textArea === null ||
    confirmEl === null
  ) {
    return;
  }

  function closeModal(): void {
    if (overlay === null || textArea === null || confirmEl === null || submitBtn === null) return;
    overlay.classList.remove("open");
    overlay.setAttribute("aria-hidden", "true");
    textArea.value = "";
    confirmEl.textContent = "";
    confirmEl.className = "";
    submitBtn.disabled = false;
  }

  // Open modal on button click
  btn.addEventListener("click", () => {
    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");
    track("feedback-opened");
    textArea.focus();
  });

  // Cancel closes modal
  cancelBtn.addEventListener("click", () => {
    closeModal();
  });

  // Overlay background click closes modal (but not clicks on inner modal)
  overlay.addEventListener("click", (event: Event) => {
    if ((event as Event & { target: EventTarget | null }).target === overlay) {
      closeModal();
    }
  });

  // Submit handler
  submitBtn.addEventListener("click", () => {
    const trimmedValue = textArea.value.trim();
    if (!trimmedValue) return;

    submitBtn.disabled = true;

    fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: trimmedValue }),
    })
      .then((response) => {
        if (response.ok) {
          confirmEl.textContent = "Thanks — feedback received!";
          confirmEl.className = "success";
          track("feedback-submitted");
          setTimeout(() => closeModal(), 2200);
        } else {
          confirmEl.textContent = "Something went wrong. Please try again.";
          confirmEl.className = "error";
          submitBtn.disabled = false;
        }
      })
      .catch(() => {
        confirmEl.textContent = "Could not send. Check your connection.";
        confirmEl.className = "error";
        submitBtn.disabled = false;
      });
  });
}
