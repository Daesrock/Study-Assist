### **Self-Contained Manual QA**

Moved manual QA from example.com to a dedicated extension page opened from the dashboard. Moodle and NetAcad scenarios now use their own responsive layout and styles, without depending on an external site's appearance. The dashboard can open or reuse the QA page.

QA access remains restricted to the exact QA page and its registered tab.

### **Selectable QA Answers**

Added accessible radio controls to simulated Moodle and NetAcad multiple-choice questions, including keyboard focus and a soft blue selection state. Each question has an independent selection, which remains marked while navigating a quiz and resets when the scenario is reopened or reloaded.

Selections are visual only; they do not grade answers or change the question content.

### **Simplified QA Interface**

Replaced the dashed blue border with a white card, subtle outline, rounded corners, and light shadow. Removed duplicate sandbox titles and scenario labels. Quick-mode shortcut hints are now hidden in detailed/streaming mode.

### **Long-Running Analysis Fix**

Fixed interrupted Quick and streaming analyses when a slow provider response caused the extension worker to stop during the wait. The worker now remains active while an analysis is pending and releases that activity on completion, failure, or cancellation.

This addresses the intermittent connection-loss errors and `!` indicator observed with NVIDIA NIM. Verified with delayed responses in an isolated Edge A/B test and confirmed during manual NVIDIA NIM testing.

### **QA Session Recovery**

QA tabs now refresh their registration before each Quick or streaming analysis. This prevents `Unsupported page URL` errors after the extension worker restarts while the QA page remains open.

### **Dashboard QA Badge Fix**

Fixed Moodle QA requests appearing as platform `moodle` in the dashboard. New Moodle and NetAcad QA records are consistently marked with the **QA** badge in both Quick and streaming modes.

### **Release Diagnostics**

Disabled development logging and removed the local log-server permission from the release manifest. The release clears a previously enabled debug setting when the extension worker starts.

### **Upgrade Notes**

After updating, reload the extension and any open QA or study pages.

The QA badge fix applies to new history records. Existing records retain their saved platform labels.

**Full changelog:** [v1.3.0...v1.3.1](https://github.com/Daesrock/Study-Assist/compare/v1.3.0...v1.3.1)
