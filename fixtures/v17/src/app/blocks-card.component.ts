import { NgForOf } from '@angular/common';
import { Component } from '@angular/core';

// An isolated case from a production project: *ngFy silences resolution across the whole template.
@Component({
  selector: 'app-blocks-card',
  standalone: true,
  imports: [NgForOf],
  templateUrl: './blocks-card.component.html',
})
export class BlocksCardComponent {
  title = 'Hello';

  items = ['a', 'b'];
}
