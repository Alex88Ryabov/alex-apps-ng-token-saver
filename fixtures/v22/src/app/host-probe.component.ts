import { Component, HostListener } from '@angular/core';

// Repro probe: a host listener passing $event into a zero-argument method. The compiler
// anchors this error in the .ts while the template stays valid — the field report case.
@Component({
  selector: 'app-host-probe',
  templateUrl: './host-probe.component.html',
})
export class HostProbeComponent {
  title = 'probe';

  @HostListener('window:beforeunload', ['$event'])
  tabClose(): void {}
}
