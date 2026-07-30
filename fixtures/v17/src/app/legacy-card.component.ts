// Legacy style common on v17: an input as a get/set pair with the decorator on the second half,
// an input declared as a string in the decorator, and an output via EventEmitter. Naive member
// parsing by first name loses the value input entirely here.
import { Component, EventEmitter, Input, Output } from '@angular/core';

@Component({
  selector: 'app-legacy-card',
  standalone: true,
  inputs: ['size'],
  template: '<p (click)="picked.emit(1)">{{ value }} {{ size }}</p>',
})
export class LegacyCardComponent {
  size = 'large';

  private _value = '';

  get value(): string {
    return this._value;
  }

  @Input()
  set value(next: string) {
    this._value = next;
  }

  @Output() picked = new EventEmitter<number>();

  reset(): void;
  reset(next: string): void;
  reset(next?: string): void {
    this._value = next ?? '';
  }
}
