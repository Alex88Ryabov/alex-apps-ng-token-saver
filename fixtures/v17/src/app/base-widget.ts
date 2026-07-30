import { EventEmitter, Input, Output } from '@angular/core';

export class BaseWidget {
  @Input() disabled = false;
  @Output() blurred = new EventEmitter<void>();

  focus(): void {}

  private token = 1;
}
