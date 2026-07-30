import { Component, input, output } from '@angular/core';

export interface UserVm {
  id: number;
  fullName: string;
}

// No standalone: true - it is the default from v19 (measured, section 2.14). No explicit OnPush.
@Component({
  selector: 'app-user-card',
  templateUrl: './user-card.component.html',
})
export class UserCardComponent {
  user = input.required<UserVm>();

  selected = output<number>();

  greeting = 'Hello';

  onSelect(id: number): void {
    this.selected.emit(id);
  }
}
