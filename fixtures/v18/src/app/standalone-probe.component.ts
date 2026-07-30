// Probe for the 'standalone by default' boundary: imports is valid only on a standalone component.
// The flag is omitted on purpose: on v18 that is an error, on v19 it no longer is.
import { NgIf } from '@angular/common';
import { Component } from '@angular/core';

@Component({
  selector: 'app-standalone-probe',
  imports: [NgIf],
  template: '<p *ngIf="ok">ok</p>',
})
export class StandaloneProbeComponent {
  ok = true;
}
